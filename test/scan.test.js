import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ctrlpi-lab.js', import.meta.url), 'utf8');
const scanning = source.slice(source.indexOf('const DEFAULT_AGENT_KEY'), source.indexOf('// ── router'));
const limited = source.slice(source.indexOf('async function runLimited'), source.indexOf('// ── start'));

test('backend emits a responding agent before the remaining probes finish', async () => {
    let release;
    const slowProbe = new Promise(resolve => { release = resolve; });
    let firstResponse;
    const ready = new Promise(resolve => { firstResponse = resolve; });
    const events = [];
    let ended = false;
    const context = vm.createContext({
        console, URL, AbortSignal,
        detectLocalIp: async () => '192.168.1.10',
        loadServers: () => [{ url: 'http://192.168.1.1:8314', api_key: 'saved-key' }],
        upsertServer() {}, saveOnlineAgents() {},
        fetch: async url => {
            if (url === 'http://192.168.1.1:8314/hello') return { status: 200, json: async () => ({ name: 'Zulu' }) };
            await slowProbe;
            return { status: 404 };
        },
    });
    vm.runInContext(scanning + limited, context);
    const response = {
        writeHead(status, headers) { assert.equal(headers['Content-Type'], 'application/x-ndjson'); },
        flushHeaders() {},
        write(line) { const event = JSON.parse(line); events.push(event); if (event.type === 'agent') firstResponse(); },
        end() { ended = true; },
    };
    const scan = context.handleScan({}, response, new URL('http://lab/api/scan?port=8314&stream=1'));
    await ready;
    assert.equal(ended, false);
    assert.deepEqual(events[0], { type: 'agent', agent: { url: 'http://192.168.1.1:8314', name: 'Zulu', api_key: 'saved-key' } });
    release();
    await scan;
    assert.equal(ended, true);
    assert.equal(events.at(-1).type, 'done');
    assert.deepEqual(events.at(-1).found, ['http://192.168.1.1:8314']);
});
