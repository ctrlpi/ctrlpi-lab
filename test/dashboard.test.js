import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboard } from './helpers/dashboard.js';

test('assembled dashboard scripts parse and register scan and agent controls', () => {
    const { context } = dashboard();
    for (const name of ['openScanModal', 'runNetworkScan', 'loadSavedServers', 'pickSavedServer']) {
        assert.equal(typeof context[name], 'function');
    }
});

test('scan results populate choices and selecting an agent applies its address and saved key', async () => {
    const servers = [
        { url: 'http://192.168.1.20:8314', name: 'Zulu', api_key: 'z-key' },
        { url: 'http://192.168.1.21:8314', name: 'Alpha', api_key: 'a-key' },
    ];
    const calls = [];
    const { context, get } = dashboard(async url => {
        calls.push(url);
        if (url === '/api/scan?port=8314') {
            return { ok: true, json: async () => ({
                subnet: '192.168.1.0/24', found: servers.map(s => s.url),
                names: Object.fromEntries(servers.map(s => [s.url, s.name])),
            }) };
        }
        assert.equal(url, '/api/servers');
        return { ok: true, json: async () => ({ servers }) };
    });
    get('apiPortInput').value = '8314';
    await context.runNetworkScan();
    assert.deepEqual(calls, ['/api/scan?port=8314', '/api/servers']);
    assert.equal(get('scanProgressFill').style.width, '100%');
    assert.match(get('savedServersPanel').children[0].textContent, /Alpha/);
    assert.match(get('savedServersPanel').children[1].textContent, /Zulu/);
    assert.equal(get('scanResultsList').children.length, 2);

    // Stub unrelated API requests and tab rendering; exercise the real selection/key lookup.
    context.onApiConfigChange = () => context.applySavedKeyForCurrentHost();
    context.switchTab = () => {};
    context.selectEndpoint = () => {};
    get('scanResultsList').children[0].onclick();
    assert.equal(get('apiHostInput').value, 'http://192.168.1.21');
    assert.equal(get('apiPortInput').value, '8314');
    assert.equal(get('apiKeyInput').value, 'a-key');
});

test('scan failure is displayed and the scan indicator stops', async () => {
    const { context, get } = dashboard(async () => { throw new Error('Connection lost'); });
    let stopped = false;
    get('scanNetworkBtn').classList.remove = name => { stopped = name === 'scanning'; };
    await context.runNetworkScan();
    assert.equal(get('scanStatusLine').textContent, 'Scan failed.');
    assert.match(get('scanResultsList').innerHTML, /Connection lost/);
    assert.ok(stopped);
});

for (const localStatus of [200, 503, 'timeout']) {
    test(`startup prefers localhost or first response (localhost ${localStatus})`, async () => {
        const servers = [
            { url: 'http://192.168.1.20:8314', name: 'Zulu', api_key: 'z-key' },
            { url: 'http://192.168.1.21:8314', name: 'alpha', api_key: 'a-key' },
            { url: 'http://localhost:8314', name: 'Local', api_key: 'local-key' },
        ];
        const calls = [];
        const { context, get } = dashboard(async url => {
            calls.push(url);
            if (url === '/api/default-config') return { ok: true, json: async () => ({
                api_host: 'http://old-agent', api_port: '8314', api_key: 'default-key', local_network_prefix: '192.168.1.'
            }) };
            if (url === '/api/servers') return { ok: true, json: async () => ({
                servers, last_modified: Date.now() / 1000, online_agents: [servers[0].url]
            }) };
            if (url.startsWith('/api/proxy/url?')) {
                assert.equal(new URL(url, 'http://lab').searchParams.get('url'), 'http://localhost:8314/hello');
                if (localStatus === 'timeout') throw new Error('Timed out');
                return { ok: localStatus === 200 };
            }
            assert.equal(url, '/api/scan?port=8314&stream=1');
            return { ok: true, json: async () => ({
                subnet: '192.168.1.0/24', found: servers.slice(0, 2).map(s => s.url),
                names: Object.fromEntries(servers.slice(0, 2).map(s => [s.url, s.name]))
            }) };
        });
        context.localStorage.getItem = () => 'http://previous-agent:9000';
        context.onApiConfigChange = () => context.applySavedKeyForCurrentHost();
        await context.autoConfigureDefaults();
        assert.equal(get('apiHostInput').value, localStatus === 200 ? 'http://localhost' : 'http://192.168.1.20');
        assert.equal(get('apiKeyInput').value, localStatus === 200 ? 'local-key' : 'z-key');
        assert.equal(calls.includes('/api/scan?port=8314&stream=1'), localStatus !== 200);
        context.openAddAgentDialog();
        assert.equal(get('newAgentHost').value, '192.168.1.');
        assert.equal(get('newAgentHost').selectionStart, '192.168.1.'.length);
        assert.equal(get('newAgentHost').selectionEnd, '192.168.1.'.length);
        assert.equal(get('newAgentKey').value, 'your-secret-key');
    });
}


test('manual agent validates host and port', () => {
    const { context } = dashboard();
    assert.equal(context.newAgentUrl('192.168.1.5', '8314'), 'http://192.168.1.5:8314');
    assert.equal(context.newAgentUrl('pi.local', '80'), 'http://pi.local:80');
    assert.equal(context.newAgentUrl('::1', '8314'), 'http://[::1]:8314');
    for (const [host, port] of [['192.168.1.', '8314'], ['', '8314'], ['pi.local/path', '8314'], ['pi.local', '65536'], ['pi.local', '0'], ['999.999.1.1', '8314']]) {
        assert.throws(() => context.newAgentUrl(host, port));
    }
});

test('manual agent saves credentials before selecting and closes only on success', async () => {
    let saved;
    const probes = [];
    const { context, get } = dashboard(async (url, options) => {
        if (url.startsWith('/api/proxy/url?')) {
            const target = new URL(url, 'http://lab').searchParams.get('url');
            probes.push(target);
            if (target.endsWith('/config/read')) assert.equal(options.headers['Api-Key'], 'test-agent-key');
            return { ok: true, json: async () => ({}) };
        }
        assert.equal(url, '/api/servers');
        if (!options) return { ok: true, json: async () => ({ servers: [saved] }) };
        assert.equal(options.method, 'POST');
        saved = JSON.parse(options.body);
        return { ok: true, json: async () => ({ servers: [saved] }) };
    });
    get('newAgentHost').value = 'pi.local';
    get('newAgentPort').value = '9000';
    get('newAgentKey').value = 'test-agent-key';
    context.onApiConfigChange = () => { context.applySavedKeyForCurrentHost(); context.updateAgentAddress(); };
    context.switchTab = () => {};
    context.selectEndpoint = () => {};
    await context.saveNewAgent();
    assert.deepEqual(probes.slice(0, 2), ['http://pi.local:9000/hello', 'http://pi.local:9000/config/read']);
    assert.deepEqual(saved, { url: 'http://pi.local:9000', api_key: 'test-agent-key' });
    assert.equal(get('agentAddress').textContent, 'pi.local:9000');
    assert.equal(get('apiKeyInput').value, 'test-agent-key');
    assert.equal(get('newAgentKey').value, '');
    assert.equal(get('addAgentDialog').closed, true);
});

test('manual agent save failure keeps the dialog open and reports the error', async () => {
    const { context, get } = dashboard(async url => ({ ok: url.startsWith('/api/proxy/url?') }));
    get('newAgentHost').value = 'pi.local';
    get('newAgentPort').value = '8314';
    await context.saveNewAgent();
    assert.match(get('addAgentError').textContent, /Could not save/);
    assert.equal(get('addAgentDialog').closed, undefined);
    assert.equal(get('addAgentSubmit').disabled, false);
});

for (const failure of ['offline', 'timeout', 401, 403, 502, 'key-timeout']) {
    test(`manual agent does not save when validation fails: ${failure}`, async () => {
        let saves = 0;
        const { context, get } = dashboard(async url => {
            if (url === '/api/servers') { saves++; return { ok: true }; }
            const target = new URL(url, 'http://lab').searchParams.get('url');
            assert.ok(target, 'agent checks must use the backend proxy');
            if (target.endsWith('/hello')) {
                if (failure === 'timeout') throw new Error('Timed out');
                return { ok: failure !== 'offline' };
            }
            if (failure === 'key-timeout') throw new Error('Timed out');
            return { ok: false, status: failure };
        });
        get('newAgentHost').value = 'pi.local';
        get('newAgentPort').value = '8314';
        get('newAgentKey').value = 'test-key';
        await context.saveNewAgent();
        assert.equal(saves, 0);
        const message = failure === 'offline' || failure === 'timeout' ? /Agent unreachable/
            : failure === 401 || failure === 403 ? /Wrong API key/ : /Could not verify/;
        assert.match(get('addAgentError').textContent, message);
        assert.equal(get('addAgentDialog').closed, undefined);
        assert.equal(get('addAgentSubmit').disabled, false);
        assert.equal(get('addAgentCancel').disabled, false);
        assert.equal(get('newAgentKey').value, 'test-key');
    });
}

test('dropdown loads board models and formats name, model and address', async () => {
    const { context, get } = dashboard(async (url, options) => {
        const target = new URL(url, 'http://lab').searchParams.get('url');
        if (target === 'http://pi.local:8314/config/read') {
            assert.equal(options.headers['Api-Key'], 'pi-key');
            return { ok: true, json: async () => ({ agent: { platform: 'Pi Zero W Rev 1.1' } }) };
        }
        throw new Error('Offline');
    });
    await context.loadSavedServers([
        { name: 'B1', url: 'http://pi.local:8314', api_key: 'pi-key' },
        { name: 'Offline', url: 'http://offline.local:8314', api_key: '' }
    ]);
    await context.loadAgentModels();
    const labels = get('savedServersPanel').children.map(item => item.textContent);
    assert.ok(labels.includes('B1 - Pi Zero W Rev 1.1 pi.local:8314'));
    assert.ok(labels.includes('Offline offline.local:8314'));
});


test('startup connects before scan completes and keeps the first responder selected', async () => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    const first = { url: 'http://192.168.1.20:8314', name: 'Zulu', api_key: 'z-key' };
    const later = { url: 'http://192.168.1.21:8314', name: 'Alpha', api_key: 'a-key' };
    const { context, get } = dashboard(async url => {
        if (url.includes('/api/scan?')) return { ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: stream };
        assert.equal(url, '/api/servers');
        return { ok: true, json: async () => ({ servers: [first, later] }) };
    });
    context.onApiConfigChange = () => context.applySavedKeyForCurrentHost();
    get('apiPortInput').value = '8314';
    let connected;
    const ready = new Promise(resolve => { connected = resolve; });
    let finished = false;
    const scan = context.runNetworkScan(true, connected).then(() => { finished = true; });
    const send = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    send({ type: 'agent', agent: first });
    await ready;
    assert.equal(finished, false);
    assert.equal(get('apiHostInput').value, 'http://192.168.1.20');
    assert.equal(get('apiKeyInput').value, 'z-key');
    send({ type: 'agent', agent: later });
    send({ type: 'done', subnet: '192.168.1.0/24', found: [later.url, first.url], names: { [first.url]: first.name, [later.url]: later.name } });
    controller.close();
    await scan;
    assert.equal(get('apiHostInput').value, 'http://192.168.1.20');
    assert.equal(get('scanProgressFill').style.width, '100%');
});

test('log viewer searches case-insensitively and hides polling requests', async () => {
    const { context, get } = dashboard(async (url, options) => {
        assert.equal(new URL(url, 'http://lab').searchParams.get('url'), 'http://pi.local:8314/logs');
        assert.equal(options.headers['Api-Key'], 'log-key');
        return { ok: true, json: async () => ({ logs: ['[API] GET /logs', '[WEBHOOK] Delivered', '[GPIO] Changed'] }) };
    });
    context.document.querySelector = () => ({ classList: { contains: () => true } });
    get('apiHostInput').value = 'http://pi.local';
    get('apiPortInput').value = '8314';
    get('apiKeyInput').value = 'log-key';
    get('logSearchInput').value = 'delivered';
    await context.fetchLogs();
    assert.equal(get('logLinesCount').innerText, 1);
    assert.match(get('logTerminalScreen').innerHTML, /log-tag-webhook/);
    assert.ok(!get('logTerminalScreen').innerHTML.includes('GET /logs'));
});

test('webhook viewer renders proxied events and escapes event content', async () => {
    const { context, get, evaluate } = dashboard(async url => {
        assert.equal(new URL(url, 'http://lab').searchParams.get('url'), 'https://ctrlpi.com/webhook/data');
        return { ok: true, json: async () => ({ events: [{ ts: 'now', api_key: '<key>', body: { note: '<script>' } }] }) };
    });
    evaluate('_cachedPiConfig = { notifications: { webhook: "https://ctrlpi.com/webhook/test" } }');
    await context.fetchWebhooks();
    assert.equal(get('webhookCount').textContent, '1');
    assert.match(get('webhookTbody').innerHTML, /&lt;script&gt;/);
    assert.match(get('webhookTbody').innerHTML, /&lt;key&gt;/);
});

test('log and webhook polling replace their timers and stop in Manual mode', () => {
    const { context, get } = dashboard();
    const intervals = [];
    const cleared = [];
    context.setInterval = (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; };
    context.clearInterval = id => cleared.push(id);
    get('refreshRateSelect').value = '20000';
    get('webhookPollSelect').value = '20000';
    context.setupLogAutoRefresh();
    context.setupWebhookAutoRefresh();
    assert.deepEqual(intervals.map(item => item.ms), [20000, 20000]);
    get('refreshRateSelect').value = 'manual';
    get('webhookPollSelect').value = 'manual';
    context.setupLogAutoRefresh();
    context.setupWebhookAutoRefresh();
    assert.deepEqual(cleared, [1, 2]);
    assert.equal(intervals.length, 2);
});
