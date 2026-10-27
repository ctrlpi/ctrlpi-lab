import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboard } from './helpers/dashboard.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// Register cleanup before waiting for readiness, including failed starts.
async function start(t, command, args, options, pattern) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const ended = once(child, 'exit');
        // Use IPC for graceful shutdown on Windows, where SIGTERM terminates immediately.
        if (child.connected) child.send('shutdown', error => { if (error) child.kill(); });
        else child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await ended; } finally { clearTimeout(timer); }
    });
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Startup timed out: ${output}`)), 10000);
        const onData = () => { const match = output.match(pattern); if (match) finish(null, Number(match[1])); };
        const onExit = () => finish(new Error(`Process exited during startup: ${output}`));
        function finish(error, port) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            child.off('error', finish);
            child.off('exit', onExit);
            error ? reject(error) : resolve(port);
        }
        child.stdout.on('data', onData);
        child.once('error', finish);
        child.once('exit', onExit);
    });
}

test('lab HTTP integration with ctrlpi-cli mock agent', { timeout: 30000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctrlpi-lab-test-'));
    // Cleanup order is explicit: children stop before the temporary files disappear.
    try {
        await t.test('isolated server lifecycle and requests', async t => {
            const agentPort = await start(t, process.env.PYTHON || 'python3',
                ['-u', path.join(root, 'test/fixtures/mock_agent.py'), '--port', '0', '--name', 'lab-test-agent'],
                { cwd: dir }, /on port (\d+)/);
            const agent = `http://127.0.0.1:${agentPort}`;
            await fs.writeFile(path.join(dir, 'agents-config.json'), JSON.stringify({
                unrelated: { preserved: true },
                agents: [{ name: 'lab-test-agent', ip: '127.0.0.1', port: agentPort, api_key: 'your-secret-key' }]
            }));
            await fs.writeFile(path.join(dir, 'lab-config.json'), JSON.stringify({ selected_agent: { ip: '127.0.0.1', port: agentPort } }));
            const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test' };
            delete env.API_KEY;
            const port = await start(t, process.execPath,
                [path.join(root, 'ctrlpi-lab.js'), '--config', dir, '--no-open', '--no-startup-scan'],
                { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }, /http:\/\/localhost:(\d+)/);
            const base = `http://127.0.0.1:${port}`;
            const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
            const post = (route, body) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const proxy = (route, body, key = 'your-secret-key') => request('/api/proxy/url?url=' + encodeURIComponent(agent + route), {
                method: body === undefined ? 'GET' : 'POST', headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });

            await t.test('assembled dashboard and static pages are served', async () => {
                const response = await request('/');
                assert.equal(response.status, 200);
                const html = await response.text();
                assert.ok(!html.includes('<!--INCLUDE:'));
                for (const text of ['Webhook Events', 'Install the API on a Raspberry Pi', 'id="curl9"']) assert.ok(html.includes(text));
                assert.equal((await request('/pages/logs.html')).status, 200);
                assert.equal((await request('/missing')).status, 404);
                assert.equal((await post('/api/reload-cache', {})).status, 200);
            });
            await t.test('proxy relays unauthenticated health and authentication errors', async () => {
                assert.equal((await (await proxy('/hello', undefined, '')).json()).name, 'lab-test-agent');
                const denied = await proxy('/config/read', undefined, 'wrong');
                assert.equal(denied.status, 403);
                assert.match((await denied.json()).error, /Api-Key/);
                assert.equal((await proxy('/missing')).status, 404);
                assert.equal((await proxy('/gpio/read/error_pin')).status, 500);
                assert.equal((await request('/api/proxy/url')).status, 400);
                assert.equal((await request('/api/proxy/url?url=' + encodeURIComponent('http://127.0.0.1:0/hello'))).status, 502);
            });
            await t.test('GPIO configuration and writes survive subsequent reads', async () => {
                assert.equal((await proxy('/gpio/config/26', { type: 'output', name: 'relay' })).status, 200);
                for (const value of [1, 0, 'toggle']) {
                    assert.equal((await proxy('/gpio/write/26', { value })).status, 200);
                    assert.equal((await (await proxy('/gpio/read/26')).json()).value, value === 'toggle' ? 1 : value);
                }
                assert.equal((await (await proxy('/config/read')).json()).gpios['26'].name, 'relay');
            });
            await t.test('sensor configure, read and remove travel through the proxy', async () => {
                await proxy('/sensor/config/example', { script: 'value' });
                assert.deepEqual(await (await proxy('/sensor/read/example')).json(), { example: 42 });
                await proxy('/sensor/config/example', { remove: true });
                assert.equal((await proxy('/sensor/read/example')).status, 404);
            });
            await t.test('script list, write, read, run and remove travel through the proxy', async () => {
                const listing = await (await proxy('/script/list')).json();
                assert.equal(listing.write, 'default_key');
                const refused = await proxy('/script/write/hello.py', { content: 'result = 1' });
                assert.equal(refused.status, 403);
                await proxy('/config/update', { api_key: 'script-key' });
                try {
                    const written = await proxy('/script/write/hello.py', { content: 'result = 1' }, 'script-key');
                    assert.deepEqual(await written.json(), { name: 'hello.py', size: 10 });
                    assert.equal((await (await proxy('/script/read/hello.py', undefined, 'script-key')).json()).content, 'result = 1');
                    const ran = await proxy('/script/run/hello.py', { args: ['zone1', '21'] }, 'script-key');
                    assert.deepEqual(await ran.json(), { name: 'hello.py', exit_code: 0, output: 'ran hello.py zone1 21' });
                    await proxy('/script/write/hello.py', { remove: true }, 'script-key');
                    assert.equal((await proxy('/script/read/hello.py', undefined, 'script-key')).status, 404);
                } finally {
                    await proxy('/config/update', { api_key: 'your-secret-key' }, 'script-key');
                }
            });
            await t.test('config updates, loads and key rotation are forwarded', async () => {
                await proxy('/config/update', { log_days: 3 });
                assert.equal((await (await proxy('/config/read')).json()).log_days, 3);
                await proxy('/config/update', { api_key: 'rotated-key' });
                assert.equal((await proxy('/config/read')).status, 403);
                assert.equal((await proxy('/config/read', undefined, 'rotated-key')).status, 200);
                await proxy('/config/load', { api_key: 'your-secret-key', sensors: {} }, 'rotated-key');
                assert.equal((await proxy('/config/read')).status, 200);
            });
            await t.test('agent logs travel through the proxy', async () => {
                assert.deepEqual((await (await proxy('/logs')).json()).logs, ['Log line 1', 'Log line 2']);
                assert.equal((await request('/api/logs')).status, 404);
            });
            await t.test('only requests addressed to the dashboard itself are answered', async () => {
                // fetch cannot set Host or Origin, so these go through http.request.
                const raw = headers => new Promise((resolve, reject) => {
                    const req = http.request(base + '/api/default-config', { headers }, res => {
                        res.resume();
                        resolve({ status: res.statusCode, cors: res.headers['access-control-allow-origin'] });
                    });
                    req.on('error', reject);
                    req.end();
                });
                const own = await raw({});
                assert.equal(own.status, 200);
                assert.equal(own.cors, undefined, 'no CORS headers are sent');
                assert.equal((await raw({ Host: `localhost:${port}` })).status, 200);
                assert.equal((await raw({ Host: `evil.example:${port}` })).status, 403);
                assert.equal((await raw({ Origin: 'https://evil.example' })).status, 403);
                assert.equal((await raw({ Origin: `http://127.0.0.1:${port}` })).status, 200);
            });
            await t.test('add-agent browser flow uses the real proxy and persists credentials', async () => {
                const { context, get } = dashboard((url, options) => request(url, options));
                get('newAgentHost').value = '127.0.0.1';
                get('newAgentPort').value = String(agentPort);
                get('newAgentKey').value = 'wrong';
                await context.saveNewAgent();
                assert.match(get('addAgentError').textContent, /Wrong API key/);
                get('newAgentKey').value = 'your-secret-key';
                context.onApiConfigChange = () => context.applySavedKeyForCurrentHost();
                context.switchTab = () => {};
                context.selectEndpoint = () => {};
                await context.saveNewAgent();
                assert.equal(get('addAgentError').textContent, '');
                assert.equal(get('addAgentDialog').closed, true);
                assert.equal(get('apiKeyInput').value, 'your-secret-key');
                const shared = JSON.parse(await fs.readFile(path.join(dir, 'agents-config.json'), 'utf8'));
                assert.deepEqual(shared.unrelated, { preserved: true });
                assert.equal(shared.agents.length, 1);
                assert.equal(shared.agents[0].api_key, 'your-secret-key');
                assert.ok(shared.agents[0].updated_at);
            });
            await t.test('deleting a server removes it from agents-config and preserves unrelated keys', async () => {
                const delRes = await request(`/api/servers?url=${encodeURIComponent(agent)}`, { method: 'DELETE' });
                assert.equal(delRes.status, 200);
                const data = await delRes.json();
                assert.equal(data.servers.find(s => s.url === agent), undefined);
                const shared = JSON.parse(await fs.readFile(path.join(dir, 'agents-config.json'), 'utf8'));
                assert.deepEqual(shared.unrelated, { preserved: true });
                assert.equal(shared.agents.length, 0);
            });
            await t.test('the selected agent persists as ip and port', async () => {
                assert.equal((await post('/api/save-config', { api_host: 'http://127.0.0.1', api_port: String(agentPort) })).status, 200);
                const saved = JSON.parse(await fs.readFile(path.join(dir, 'lab-config.json'), 'utf8'));
                assert.deepEqual(saved.selected_agent, { ip: '127.0.0.1', port: agentPort });
                const defaults = await (await request('/api/default-config')).json();
                assert.equal(defaults.api_url, agent);
                assert.equal(defaults.api_key, 'your-secret-key');
            });
            await t.test('direct server management through /api/servers GET, POST, and DELETE body', async () => {
                const initial = await (await request('/api/servers')).json();
                assert.ok(Array.isArray(initial.servers));
                assert.ok(Array.isArray(initial.online_agents));

                const added = await (await post('/api/servers', {
                    url: 'http://192.168.1.50:8314',
                    name: 'direct-added-pi',
                    api_key: 'custom-key'
                })).json();
                assert.ok(added.servers.some(s => s.url === 'http://192.168.1.50:8314' && s.name === 'direct-added-pi'));
                assert.ok(added.online_agents.includes('http://192.168.1.50:8314'));

                const deleted = await (await request('/api/servers', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: 'http://192.168.1.50:8314' })
                })).json();
                assert.ok(!deleted.servers.some(s => s.url === 'http://192.168.1.50:8314'));

                const badDelete = await request('/api/servers', { method: 'DELETE' });
                assert.equal(badDelete.status, 400);
            });
            await t.test('an agent saved without a key gets the default key only when it accepts it', async () => {
                await request(`/api/servers?url=${encodeURIComponent(agent)}`, { method: 'DELETE' });
                const added = await (await post('/api/servers', { url: agent, name: 'lab-test-agent' })).json();
                assert.equal(added.servers.find(s => s.url === agent).api_key, 'your-secret-key');
                const shared = JSON.parse(await fs.readFile(path.join(dir, 'agents-config.json'), 'utf8'));
                assert.equal(shared.agents.find(a => a.port === agentPort).api_key, 'your-secret-key');

                const unreachable = 'http://127.0.0.1:1';
                const offline = await (await post('/api/servers', { url: unreachable })).json();
                assert.equal(offline.servers.find(s => s.url === unreachable).api_key, '');
                await request(`/api/servers?url=${encodeURIComponent(unreachable)}`, { method: 'DELETE' });
            });
            await t.test('malformed and oversized requests are rejected', async () => {
                assert.equal((await request('/api/save-config', { method: 'POST', body: '{' })).status, 400);
                assert.equal((await request('/api/save-config', { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
                assert.equal((await post('/api/servers', {})).status, 400);
                assert.equal((await request('/api/scan?port=99999')).status, 400);
                assert.equal((await request('/api/scan?port=abc')).status, 400);
            });
        });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
