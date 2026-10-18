# CLAUDE.md - ctrlpi-lab

## Project and scope

ctrlpi-lab is a local dashboard for `pi-gpio-api`, `pico-gpio-api` and `esp32-gpio-api`. It serves a
three-tab SPA: **API**, **Logs**, and **Webhooks**. It is not a GPIO agent.
`ctrlpi-lab.js` uses Node’s built-in HTTP server and fetch; there are no runtime dependencies.
Node 20+ is required. Python 3 is required for integration tests. There are no npm
runtime or development dependencies; no installation step is needed.

There is no MCP tab and no MCP code: MCP clients use the separate `mcp-bridge` project.

## Running and refreshing

```bash
npm run dev             # NODE_ENV=development; opens the dashboard, default port 7474
npm start               # normal server startup
PORT=9000 node ctrlpi-lab.js    # override the listening port
```

There is no `run.sh` or `legacy/` directory in this checkout.

- `--host <address>` or `HOST` controls the listening interface; default is `127.0.0.1`.
- `PORT=0` requests an OS-assigned port; startup output prints the actual port.
- `--no-open` skips opening a browser.
- `--no-startup-scan` skips automatic backend discovery.
- `--config <directory-or-json-path>` selects an isolated configuration location.

`loadIndexHtml()` resolves recursive `<!--INCLUDE:...-->` directives and caches the
result. After page edits, restart and refresh, or use the **Reload page cache**
header icon shown in development mode. It calls `POST /api/reload-cache` and then
reloads the browser. The theme toggle does not reload the HTML cache.

## Files

```text
ctrlpi-lab.js                       HTTP server, proxy, config persistence, discovery
pages/main.html              CSS, header/nav, endpoint definitions, shared browser JS
pages/api.html               REST tester pane
pages/logs.html              Log toolbar and terminal
pages/webhooks.html          Webhook Events toolbar and table
pages/welcome.html           Overview, quick start, Pi/Pico/ESP32 and mcp-bridge installation
pages/api_curl.html          Nine cURL example containers

test/dashboard.test.js       Browser-function tests using a small DOM/fetch stub
test/scan.test.js            Isolated incremental-discovery test
test/integration.test.js     Real lab server + mock-agent HTTP tests
test/helpers/dashboard.js   Assembles/evaluates dashboard scripts for tests
test/fixtures/mock_agent.py  The shared Python mock agent
.github/workflows/ci.yml     GitHub Actions test matrix
```

## Configuration and credentials

Configuration defaults to `~/.ctrlpi/`, never the checkout. `--config` accepts a
directory for both files or a JSON path for the lab file, with the shared file in
the same directory. Page files always resolve relative to `ctrlpi-lab.js`.
When reading shared agents, `ctrlpi-lab` checks if `/var/lib/homebridge/ctrlpi-agents-config.json`
exists, reading it read-only and reconciling agents whose `updated_at` is newer. It never writes to the Homebridge path.

Shared `agents-config.json`:

```json
{
  "agents": [
    { "name": "pi5", "ip": "192.168.1.50", "port": 8314, "api_key": "agent-key", "updated_at": "2026-10-11 12:00:00" }
  ]
}
```

Dashboard-owned `lab-config.json`:

```json
{
  "selected_agent": { "ip": "192.168.1.50", "port": 8314 },
  "online_agents": ["192.168.1.50:8314"]
}
```

Backend defaults prefer `API_KEY`, then an explicit `selected_agent.api_key`, then the
matching shared agent’s key, finally `your-secret-key`. The shared file is read only from
its own name: there is no fallback to an older `config.json`.

Persist addresses as `ip` + numeric `port`; `online_agents` holds `ip:port` strings.
The frontend/API wire format uses URLs, converted at the persistence boundary by
`agentToUrl`, `urlToAgent`, and `stripScheme`. Updating shared agents must preserve
unrelated keys in the shared file. Do not migrate settings into checkout-local files.

`online_agents` is scan history, not a live filter. Keep all saved agents in
`_savedServersCache` so an agent missing from the scan retains its credentials
and remains selectable.

## Discovery and selection

Backend startup checks saved agents if shared config is less than five minutes old;
otherwise it sweeps the local /24. `--no-startup-scan` disables this startup work.
Manual `/api/scan` uses the same subnet scanner. Probes have a 1500 ms timeout and
at most 48 run concurrently. Preserve these limits for slower Pi/Pico boards.

Discovery checks `/hello`. Existing saved keys are preserved. For a new agent without
a key, the default key is checked against `/config/read` and saved only if accepted.
`stream=1` returns NDJSON `agent` events followed by `done`, letting the dashboard
connect before the entire scan finishes.

On page load, `autoConfigureDefaults()` starts with localhost and the configured
agent port, loads saved credentials, and probes `/hello`. If localhost is unavailable,
it selects the first responding LAN agent while scanning continues. This differs
from simply reopening the persisted selected host. Dropdown entries are alphabetical.

The **+** form checks `/hello`, verifies a nonempty supplied key with `/config/read`,
then saves through `/api/servers`. All checks must use `piApiFetch`, never direct
browser-to-agent fetches: direct requests can falsely report live agents as unreachable
due to CORS. Reject invalid keys and failed verification without saving or closing.

## HTTP surface

| Route | Behavior |
|---|---|
| `GET /` | Cached assembled dashboard |
| `POST /api/reload-cache` | Rebuild HTML cache |
| `GET /api/default-config` | Connection defaults, network prefix, development-mode flag |
| `POST /api/save-config` | Persist the selected agent |
| `GET /api/servers` | Saved agent list and scan history |
| `POST /api/servers` | Add/update a shared agent record |
| `DELETE /api/servers` | Remove a shared agent record and scan history |
| `GET /api/scan?port=8314` | Discover agents; `stream=1` enables NDJSON |
| `* /api/proxy/url?url=...` | Relay method, body, allowed headers, and upstream HTTP status |
| `GET /pages/*` | Static page files |

The proxy forwards `Api-Key`, content type and accept. It returns upstream failures with
their status and connection failures as 502. JSON body parsing rejects malformed input;
request bodies are capped at 64 KiB.

**Request guard (`dispatch()`).** No CORS headers are sent. `hostAllowed()` answers 403
unless the `Host` is an IP address, `localhost`, `os.hostname()` (with or without `.local`)
or the `--host` value, which blocks DNS rebinding; an `Origin`, when sent, must equal the
`Host`. Without this a web page could read `/api/default-config` (it holds the agent key)
and drive the LAN through the proxy. Keep both checks in front of every route.

## Frontend behavior

- **API:** endpoint definitions live in `pages/main.html`. Requests target the header’s
  selected agent through `piApiFetch`. Config Update has only one API-key change
  control, in the red Danger Zone; do not re-add an ordinary `api_key` body field.
  GPIO path fields accept any pin number, since each agent checks it against its own board
  (Pico GP0-28, ESP32 up to 48). `value` and `init` 1/0 are sent as numbers: the MicroPython
  agents and `lite.py` refuse them as text.
- **Logs:** reads the selected agent’s `/logs` via `piApiFetch`, filters search text
  in the browser, and hides polling entries.
  Keep compact line spacing and orange `[webhook]`/`[webhock]` tags. No category buttons.
  Reset and refresh are accessible icon-only buttons after search; trash is red.
  Reset asks for confirmation, reads the agent config, sets `log_days=0`, then restores it.
- **Webhooks:** title is **Webhook Events**, followed by the refresh icon. When the
  cached agent config’s webhook URL contains `ctrlpi.com`, fetch the public test feed
  through the proxy. This is not a private per-agent feed. Escape external table content.
- Both viewers offer 3s, 10s, **20s default**, 30s, and Manual polling plus auto-scroll.
- Theme selection persists in localStorage. Icon-only buttons need titles and accessible labels.

Keep the nine cURL examples aligned with `../pi-gpio-api/README.md`’s “Try the API”
section. `_populateCurlExamples()` supplies the selected URL/key. Pi sensor examples
use `cpu-temp.sh`; Pico uses `cpu-temp.py`. Welcome installation sections follow Quick
Start and use the Pi README and `../pico-gpio-api/README.md`, including Pico Bay and USB
installation. Pico runs MicroPython, not FastAPI. These sibling repositories are
reference material, not dependencies required to run tests or CI.

## Tests and CI

```bash
npm test
npm run test:ci
```

`npm test` runs `node --test`, which discovers the test files without shell glob expansion
(including on Windows). Python defaults to
`python3`; set `PYTHON` to override it. The integration fixture `test/fixtures/mock_agent.py` is the shared mock agent:
ctrlpi-cli, mcp-bridge, homekit-bridge and matter-bridge keep identical copies, so change them all together.

Integration tests spawn the real lab server and Python mock on OS-assigned loopback
ports. Use temporary configs, `HOST=127.0.0.1`, `PORT=0`, `--no-open`, and
`--no-startup-scan`. Wait for explicit readiness, bound request/startup waits, register
child cleanup before waiting, stop processes, and remove temporary files even on failures.
Never use real user config, real hardware, LAN scans, or public webhook services in CI.
The mock provides stateful GPIO and sensor/config responses; it is not full hardware emulation.

Dashboard scripts are evaluated directly with named VM sources; tests do not generate
source files. There is no coverage tooling, reporting, or minimum coverage gate.

CI runs all nine combinations of macOS/Linux (Ubuntu)/Windows and Node 22/24/26,
with Python 3, for pushes and pull requests to main/master, plus manual dispatch.
It runs `npm run test:ci` without installing npm packages. CI sets `PYTHON=python`
after setup-python. The lab subprocess uses IPC for graceful shutdown on Windows;
forced termination is only a cleanup fallback. A passing local command does not
confirm a GitHub-hosted CI run.

Covered areas include discovery/selection, manual agent validation, HTTP proxy behavior,
GPIO state changes, sensors, config/key changes, shared-config preservation, logs,
webhook rendering, and poll timers. Remaining gaps include a real browser/visual layout,
hardware timing, LAN discovery over actual interfaces, and external webhook delivery. Test relevant behavior rather than merely matching implementation.
