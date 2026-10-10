# ctrlPi Lab

[![Platform: Cross-Platform](https://img.shields.io/badge/platform-Cross--Platform-006400.svg)](#quick-start)
[![Version 0.9.25](https://img.shields.io/badge/version-0.9.25-blue.svg)](https://github.com/ctrlpi/ctrlpi-lab/tags)
[![Node.js 20+](https://img.shields.io/badge/node.js-20%2B-blue.svg)](https://nodejs.org/)
[![Auth: Api-Key](https://img.shields.io/badge/auth-Api--Key-orange.svg)](#usage)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![CI](https://github.com/ctrlpi/ctrlpi-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/ctrlpi-lab/actions/workflows/ci.yml)

A local browser dashboard for your ctrlPi setup. Test GPIO and sensor endpoints,
watch webhook events, and tail agent logs, with zero dependencies.

Runs on **macOS, Linux, and Windows** with **Node.js 20+**. The dashboard connects
to an agent’s REST API; install `pi-gpio-api` or `pico-gpio-api` on your board separately.

## Quick start

Requires Node.js 20 or newer.

```sh
npx @ctrlpi/ctrlpi-lab
```

Your browser will open automatically at [http://localhost:7474](http://localhost:7474).

Or clone and run directly (no `npm install` needed):

```bash
git clone https://github.com/ctrlpi/ctrlpi-lab.git
cd ctrlpi-lab
node ctrlpi-lab.js
```

You can also start it with `npm start`. Python is needed only for the mock-agent tests.
By default, the dashboard listens only on this computer (`127.0.0.1`). To allow LAN
devices to connect, start it with `--host 0.0.0.0`:

```bash
npx @ctrlpi/ctrlpi-lab --host 0.0.0.0
```

LAN access also exposes the dashboard’s agent credentials and unrestricted proxy to those devices.

To skip opening a browser:

```bash
npx @ctrlpi/ctrlpi-lab --no-open
```

To change the port on macOS/Linux:

```bash
PORT=9000 npx @ctrlpi/ctrlpi-lab
```

Or in Windows PowerShell:

```powershell
$env:PORT = "9000"
npx @ctrlpi/ctrlpi-lab
```

## Discovery

At startup, ctrlpi-lab scans the local /24 for agents. If the shared config was updated within
the last five minutes, it checks saved agents for reachability instead. On page load, the dashboard selects localhost on the configured agent port if `/hello` responds;
otherwise it connects to the first responding agent immediately and keeps scanning in the background.
Agent choices remain sorted alphabetically.
Automatically discovered agents are saved with the default `Api-Key` only if that key works
(otherwise with none). Scanning preserves existing saved keys. The **+** form checks reachability
and verifies a supplied key through the backend proxy before saving.

## Usage

1. Select an agent from the header dropdown, scan with the network icon, or click
   **+** to enter its IP/hostname, port (default **8314**), and API key.
2. Choose an endpoint in the **API** sidebar. Fill in its parameters and send the
   request to see the response. The key icon edits the saved connection key.
3. Open **Logs** to search the agent’s output, or **Webhooks** to inspect the public
   ctrlpi.com test feed when that target is configured on your agent.

The **Welcome to ctrlPi** panel includes Pi and Pico installation steps.
**API - cURL Examples** provides nine commands using your selected address and key.

### Examples

| Task | API endpoint | Parameters or body |
|---|---|---|
| Check whether an agent is online | `GET /hello` | No API key required |
| Read configured GPIO pins | `GET /gpio/read` | No body |
| Set GPIO 26 HIGH | `POST /gpio/write/26` | `{"value": 1}` |
| Pulse GPIO 26 for two seconds | `POST /gpio/write/26` | `{"value": 1, "duration": 2}` |
| Configure a watched input | `POST /gpio/config/6` | `{"type": "input", "watched": true}` |
| Configure a Pi sensor | `POST /sensor/config/cpu_temp` | `{"script": "cpu-temp.sh"}` |
| Read that sensor | `GET /sensor/read/cpu_temp` | No body |

All endpoints except `/hello` require the agent’s API key. On a Pico, use
`cpu-temp.py` for the example sensor. Watched inputs send events when a webhook or
bridge target is configured; otherwise, the agent logs the events.

## Configuration

Saved agents are stored in the shared `config.json`'s `agents[]` (`{name, ip, port, api_key}`), the
one list every ctrlpi project reads - add an agent here and `mcp-bridge`, `studio-bridge` and the
smart-home bridges all see it. This dashboard's own `lab-config.json` holds the rest: the agent it
is currently pointed at (`selected_agent: {ip, port}`, its key coming from that agent's `agents[]`
entry), the MCP server (`mcp: {ip, port, api_key}`), and `online_agents` (what the last network scan
reached, retained as scan history; saved agents remain selectable), as `ip:port` strings. Every host uses the same
`ip` + `port` pair, never a URL, and `mcp-bridge`'s own key is `mcp.api_key`, so no two keys mean
the same thing.

> **Where the config lives:** in `~/.ctrlpi/`, always - never next to `ctrlpi-lab.js`, whatever way you
> started it. Two files: the shared **`~/.ctrlpi/config.json`** holds `agents[]` (every ctrlpi project
> reads and updates that one list), and **`~/.ctrlpi/lab-config.json`** holds what only this dashboard
> owns (`selected_agent`, the `mcp` section, `online_agents`). Pass `--config <path>` (a `.json` file,
> or a directory to hold both) to put them anywhere else.

Both files are optional. For example, the shared `~/.ctrlpi/config.json` can contain:

```json
{
  "agents": [
    { "name": "garage-pi", "ip": "192.168.1.50", "port": 8314, "api_key": "your-secret-key" }
  ]
}
```

The dashboard’s `~/.ctrlpi/lab-config.json` stores its selected agent and scan history:

```json
{
  "selected_agent": { "ip": "192.168.1.50", "port": 8314 },
  "online_agents": ["192.168.1.50:8314"]
}
```

The backend also preserves optional MCP settings as
`mcp: {ip, port, api_key}` for compatibility; the current dashboard has no MCP tab
or registered stdio MCP routes. Use `mcp-bridge` separately for MCP tools.

- The header shows the selected agent’s IP and port after its model. Use the arrow to choose a saved agent,
  or the **+** button to add an IP/hostname, port, and API key. The key icon edits the selected agent’s key.
- Environment overrides: `API_KEY` (agent key), `MCP_API_KEY` (MCP HTTP key).
- Discovered and last-used agents are saved back to the shared `~/.ctrlpi/config.json` automatically,
  so you don't have to edit it by hand.

## Tabs

- **API**: test GPIO, sensor, and configuration endpoints. The sidebar includes board pinouts,
  **Welcome to ctrlPi** with Pi/Pico installation instructions, and nine **API - cURL Examples**
  aligned with the Pi API README and populated with the selected address/key. Changing the
  agent’s API key is available only in the red Danger Zone of Config Update.
- **Logs**: compact log viewer with text search. Webhook tags are orange.
  Red trash and refresh icons sit immediately after the search box. Reset Log
  asks for confirmation, sets the agent’s `log_days` to `0`, then restores the previous value.
- **Webhooks**: **Webhook Events** displays the public ctrlpi.com test feed when the selected
  agent’s configured webhook URL contains `ctrlpi.com`. The refresh icon sits after the title.
  This is a shared test feed, not a private per-agent event store.

Logs and Webhooks offer **3s, 10s, 20s (default), 30s, and Manual** polling, plus auto-scroll.
The header includes the agent picker, **+** button, saved-key editor, light/dark toggle,
status indicator, and network scan button.

## How it works

Agent requests, including the + form’s health/key checks, pass through
`/api/proxy/url` using `piApiFetch`, avoiding browser CORS restrictions. The backend uses
Node’s built-in `http` and `fetch`, assembles HTML from `pages/`, and caches it in memory.
The Logs tab fetches the selected agent’s `/logs` through that proxy and filters in the browser;
`/api/logs` remains available as a separate backend helper. Webhook feed requests also use the proxy.

After editing HTML, restart the server and refresh the browser. In development mode
(`npm run dev`), the header’s **Reload page cache** icon rebuilds the cache and reloads the page.
The day/night toggle only changes the theme; it does not rebuild the cache.

### Backend endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | The dashboard HTML (assembled from `pages/` and cached in memory) |
| `GET` | `/api/default-config` | Connection defaults plus `local_network_prefix` and `dev_mode` |
| `POST` | `/api/save-config` | Saves `api_host` / `api_port` and/or the `mcp` section to `lab-config.json` |
| `GET` · `POST` | `/api/servers` | List / add saved agents (kept in the shared `config.json`) |
| `GET` | `/api/scan?port=` | Scans the local subnet via `/hello`; port defaults to 8314. Add `stream=1` for incremental NDJSON results |
| `GET` | `/api/logs` | Proxies the agent's `GET /logs`; supports `?limit=`, `?search=`, `?category=` |
| `*` | `/api/proxy/url?url=` | General HTTP proxy for the browser's GPIO / MCP-HTTP calls (also relays the `Mcp-Session-Id` header) |
| `POST` | `/api/reload-cache` | Rebuilds cached dashboard HTML from disk |
| `GET` | `/images/{file}` · `/pages/{file}` | Serves image and page files |

## Tests and CI

Requires Node 20+ and Python 3 (`python3`, or set `PYTHON` to its executable).

```bash
npm test                # unit tests + mock-agent HTTP integration tests
npm run test:ci         # CI entry point; runs the same tests
```

Integration tests launch the real lab server and a local copy of
`ctrlpi-cli/mock_agent.py` on OS-assigned loopback ports. They use a temporary
`--config` directory, preserve unrelated shared-config fields, and stop child
processes and delete temporary configs after each run. No Pi, Pico, public webhook
service, real credentials, or user configuration is needed. The fixture differs
from the CLI copy only in its header and reporting the actual allocated port.

The lab supports `--no-open` to skip opening a browser and `--no-startup-scan`
to skip automatic discovery. Tests use both, plus `HOST=127.0.0.1` and `PORT=0`;
normal startup still opens the browser and discovers agents as before.

No npm installation is needed for the app or tests. CI runs all nine combinations
of Node 22, 24, and 26 with macOS, Linux (Ubuntu), and Windows. Each job starts the
real lab server and the mock agent. There is no coverage reporting or coverage gate.

Tests cover agent discovery/selection, adding agents, credentials, real proxy
requests, GPIO write/read state, sensors, configuration persistence, logs, and
webhook rendering. Dashboard tests use a small DOM stub, not a browser. Hardware
timing/electrical behavior, real LAN discovery, external webhook delivery, MCP
bridge interoperability, and visual layout remain outside this suite. The mock
agent approximates the REST contract; it does not replace tests on real hardware.

## Related projects

- **[`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api)**: Raspberry Pi GPIO REST server that reads inputs and drives outputs (and named sensors) over an HTTP API.
- **[`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api)**: Raspberry Pi Pico W port of the GPIO REST server, with the same endpoints, wire format, and auth.
- **[`ctrlpi-cli`](https://github.com/ctrlpi/ctrlpi-cli)**: Command-line interface to the same agents, with shared agent configuration.
- **`mcp-bridge`**: MCP server that exposes GPIO control as tools for AI agents (e.g. Claude), executing them over the agents' REST API.
- **`homekit-bridge`**: native Apple HomeKit bridge that exposes GPIO pins and sensors as HomeKit accessories, driven over the agents' REST API.
- **`matter-bridge`**: Matter bridge that exposes GPIO pins and sensors to any Matter platform (Apple Home, Google Home, Alexa, Home Assistant), driven over the agents' REST API.

## License

[MIT](LICENSE)
