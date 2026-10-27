#!/usr/bin/env node
// Served on Node's built-in http module with zero external dependencies.
import http from "http";
import { spawn, execFile } from "child_process";
import dgram from "dgram";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Opens the dashboard in the default browser on macOS, Windows or Linux.
function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'darwin') {
    execFile('open', [url], () => {});
  } else if (plat === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '""', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

// --- Config file paths ---------------------------------------------------
// Config files are stored in ~/.ctrlpi/ (or overridden via --config <path>):
//   agents-config.json shared agent list ({name, ip, port, api_key, updated_at}) across ctrlPi tools
//   lab-config.json    dashboard state: selected_agent, online_agents
function resolveConfigFile(fileName) {
    const args = process.argv.slice(2);
    const i = args.indexOf("--config");
    let file = path.join(os.homedir(), ".ctrlpi", fileName);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) {
        const p = path.resolve(args[i + 1]);
        file = p.toLowerCase().endsWith(".json") ? p : path.join(p, fileName);
    }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {
        console.error(`Could not create ${path.dirname(file)}: ${e.message}`);
    }
    return file;
}

// UTC "YYYY-MM-DD HH:MM:SS", the stamp format shared by every ctrlPi config file.
function nowStamp() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

const CONFIG_FILE = resolveConfigFile("lab-config.json");
const SHARED_FILE = path.join(path.dirname(CONFIG_FILE), "agents-config.json");
const PAGES_DIR = path.join(__dirname, "pages");
const portArgIndex = process.argv.indexOf("--port");
if (portArgIndex >= 0 && (!process.argv[portArgIndex + 1] || process.argv[portArgIndex + 1].startsWith("--"))) {
    throw new Error("--port requires a port number, e.g. --port 7474");
}
const PORT = Number(portArgIndex >= 0 ? process.argv[portArgIndex + 1] : (process.env.PORT ?? 7474));
const hostArgIndex = process.argv.indexOf("--host");
if (hostArgIndex >= 0 && (!process.argv[hostArgIndex + 1] || process.argv[hostArgIndex + 1].startsWith("--"))) {
    throw new Error("--host requires an address, e.g. --host 0.0.0.0");
}
const HOST = hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : process.env.HOST || "127.0.0.1";
const NO_OPEN = process.argv.includes("--no-open");
const NO_STARTUP_SCAN = process.argv.includes("--no-startup-scan");
// Maximum accepted request body size (64 KB). Rejects larger payloads with 413.
const MAX_BODY = 64 * 1024;

// ── small helpers ────────────────────────────────────────────────────
// An error that carries the HTTP status the router answers with.
class HttpError extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

// Reads lab-config.json (selected_agent, online_agents).
function readConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch { /* fall through */ }
    }
    return {};
}
// Writes lab-config.json as a whole.
function writeConfig(data) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

const HOMEBRIDGE_AGENTS_FILE = "/var/lib/homebridge/ctrlpi-agents-config.json";

// Merges two agent lists by name: new names are added, and an existing entry is replaced
// only when the overlay copy has a newer updated_at.
function reconcileAgentList(baseAgents, overlayAgents) {
    const list = Array.isArray(baseAgents) ? [...baseAgents] : [];
    if (!Array.isArray(overlayAgents)) return list;
    for (const overlay of overlayAgents) {
        if (!overlay || !overlay.name) continue;
        const idx = list.findIndex(a => a && a.name === overlay.name);
        if (idx === -1) {
            list.push({ ...overlay });
        } else {
            const existing = list[idx];
            const overlayDate = overlay.updated_at || "";
            const existingDate = existing.updated_at || "";
            if (overlayDate > existingDate) {
                list[idx] = { ...existing, ...overlay };
            }
        }
    }
    return list;
}

// Reads the shared agents-config.json, then merges in newer entries from Homebridge's own
// list (/var/lib/homebridge/ctrlpi-agents-config.json), which is only ever read.
function readShared() {
    let result = {};
    if (fs.existsSync(SHARED_FILE)) {
        try { result = JSON.parse(fs.readFileSync(SHARED_FILE, "utf-8")) || {}; } catch { /* fall through */ }
    }
    if (fs.existsSync(HOMEBRIDGE_AGENTS_FILE)) {
        try {
            const hb = JSON.parse(fs.readFileSync(HOMEBRIDGE_AGENTS_FILE, "utf-8"));
            if (hb && Array.isArray(hb.agents)) {
                result.agents = reconcileAgentList(result.agents || [], hb.agents);
            }
        } catch { /* ignore read error */ }
    }
    return result;
}
// Replaces only the agents key of the shared file, keeping anything else in it.
function writeSharedAgents(agents) {
    let shared = {};
    if (fs.existsSync(SHARED_FILE)) {
        try { shared = JSON.parse(fs.readFileSync(SHARED_FILE, "utf-8")) || {}; } catch { /* fall through */ }
    }
    shared.agents = agents;
    fs.writeFileSync(SHARED_FILE, JSON.stringify(shared, null, 2));
}

// ── config: agents / scan results ────────────────────────────────────
// "http://host:port/" becomes "host:port".
function stripScheme(v) {
    return String(v || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// Agent records use {name, ip, port, api_key, updated_at}. Default agent port is 8314.
const DEFAULT_AGENT_PORT = 8314;

// The dashboard speaks URLs; these two convert to and from the stored ip + port pair.
function agentToUrl(a) {
    if (!a || !a.ip) return "";
    const host = /:\/\//.test(a.ip) ? a.ip : `http://${a.ip}`;
    return `${host}:${a.port || DEFAULT_AGENT_PORT}`;
}
function urlToAgent(url, api_key = "", name = "", updated_at = "") {
    let host = String(url || "").trim().replace(/\/+$/, "");
    let port = DEFAULT_AGENT_PORT;
    const m = host.match(/^(.*?):(\d+)$/);
    if (m && !/^https?:$/i.test(m[1])) { host = m[1]; port = Number(m[2]); }
    const ip = host.replace(/^http:\/\//i, "");
    // Other ctrlPi tools find agents by name, so it is kept whenever known.
    return {
        ...(name ? { name } : {}),
        ip,
        port,
        api_key: api_key || "",
        updated_at: updated_at || nowStamp()
    };
}

// Loads [{url, api_key, name?, updated_at?}] from shared agents-config.json.
function loadServers() {
    const raw = readShared().agents;
    return (Array.isArray(raw) ? raw : [])
        .map(a => ({
            url: agentToUrl(a),
            api_key: a.api_key || "",
            ...(a.name ? { name: a.name } : {}),
            ...(a.updated_at ? { updated_at: a.updated_at } : {})
        }))
        .filter(s => s.url);
}
// Writes the list back to the shared file, one entry per URL, sorted.
function saveServers(servers) {
    const merged = {};
    for (const s of servers) if (s.url) merged[s.url] = s;
    const agents = Object.keys(merged).sort()
        .map(u => urlToAgent(u, merged[u].api_key, merged[u].name, merged[u].updated_at));
    try { writeSharedAgents(agents); } catch { /* best effort */ }
}
// apiKey=null preserves an existing key (scan rediscovery); "" clears it.
// name: agent name from /hello - stored when non-empty, preserved otherwise.
function upsertServer(url, apiKey, name) {
    const servers = loadServers();
    const cleanName = (name || "").trim();

    // Reconciles agent when discovered under a new URL
    let existing = null;
    let oldUrl = null;
    if (cleanName) {
        const matchByName = servers.find(s => s.name === cleanName && s.url !== url);
        if (matchByName) {
            existing = { ...matchByName, url };
            oldUrl = matchByName.url;
        }
    }

    if (!existing) {
        existing = servers.find(s => s.url === url) || { url, api_key: "" };
    }

    let changed = oldUrl ? true : !servers.some(s => s.url === url);
    if (apiKey !== null && apiKey !== undefined && existing.api_key !== apiKey) {
        existing.api_key = apiKey;
        changed = true;
    }
    if (cleanName && existing.name !== cleanName) {
        existing.name = cleanName;
        changed = true;
    }
    if (changed || !existing.updated_at) {
        existing.updated_at = nowStamp();
    }

    // Filter out oldUrl if moved, or replace url if existing
    const updatedServers = servers
        .filter(s => s.url !== url && (!oldUrl || s.url !== oldUrl));
    updatedServers.push(existing);
    saveServers(updatedServers);

    if (oldUrl) {
        const online = (loadOnlineAgents() || []).filter(u => u !== oldUrl);
        saveOnlineAgents(online);

        // If the moved agent was the currently selected agent, update its selected host/port
        try {
            const cfg = readConfig();
            if (cfg.selected_agent && cfg.selected_agent.ip) {
                const oldHost = stripScheme(oldUrl).split(":")[0];
                const oldPort = stripScheme(oldUrl).split(":")[1] || "8314";
                if (stripScheme(cfg.selected_agent.ip) === oldHost &&
                    String(cfg.selected_agent.port ?? "8314") === oldPort) {
                    const newHost = stripScheme(url).split(":")[0];
                    const newPort = stripScheme(url).split(":")[1] || "8314";
                    cfg.selected_agent.ip = newHost;
                    cfg.selected_agent.port = Number(newPort) || newPort;
                    writeConfig(cfg);
                }
            }
        } catch { /* best effort */ }
    }

    return loadServers();
}
// Removes an agent from the shared list and from the scan history.
function deleteServer(url) {
    const norm = String(url || "").trim().replace(/\/+$/, "");
    const servers = loadServers().filter(s => s.url !== norm);
    saveServers(servers);
    const online = (loadOnlineAgents() || []).filter(u => u !== norm);
    saveOnlineAgents(online);
    return loadServers();
}
// Returns online agents from the most recent scan snapshot as URLs, or null if no scan has run.
function loadOnlineAgents() {
    const data = readConfig();
    if (!("online_agents" in data)) return null;
    const list = data.online_agents;
    return Array.isArray(list) ? list.map(e => `http://${stripScheme(e)}`) : list;
}
// Records what the last scan reached, as sorted "ip:port" strings.
function saveOnlineAgents(found) {
    const data = readConfig();
    data.online_agents = [...found].map(stripScheme).sort();
    try { writeConfig(data); } catch { /* best effort */ }
}

// Loads the currently selected agent ({ip, port, api_key}).
function loadSelected() {
    const sel = readConfig().selected_agent || {};
    const ip = stripScheme(sel.ip) || "localhost";
    const port = String(sel.port ?? "8314");
    // Prefer explicit selection key; fallback to matching entry in shared agents list.
    let key = sel.api_key;
    if (!key) {
        const match = loadServers().find(s => s.url === `http://${ip}:${port}`);
        key = match && match.api_key;
    }
    return { ip, port, api_key: key };
}

// The selected agent as the dashboard's form fields expect it; API_KEY overrides the key.
function getDefaultApiConfig() {
    const sel = loadSelected();
    const apiHost = `http://${sel.ip}`;
    const apiPort = sel.port;
    const apiKey = process.env.API_KEY || sel.api_key;
    return {
        api_key: apiKey || "your-secret-key",
        api_host: apiHost,
        api_port: apiPort,
        api_url: `${apiHost}:${apiPort}`,
    };
}

// ── merged dashboard HTML (recursive <!--INCLUDE:--> + in-memory cache) ─
// Splices each <!--INCLUDE:path--> in place, up to ten levels deep.
function resolveIncludes(html, baseDir, depth = 0) {
    if (depth > 10) return html;
    return html.replace(/<!--INCLUDE:([^>]+)-->/g, (_m, rel) => {
        const p = path.join(baseDir, rel.trim());
        try { return resolveIncludes(fs.readFileSync(p, "utf-8"), baseDir, depth + 1); }
        catch { return `<!-- INCLUDE NOT FOUND: ${rel} -->`; }
    });
}
let indexHtmlCache = null;
// Builds the dashboard page once and caches it until /api/reload-cache.
function loadIndexHtml() {
    const htmlPath = path.join(PAGES_DIR, "main.html");
    if (!fs.existsSync(htmlPath)) throw new HttpError(404, "pages/main.html file not found");
    indexHtmlCache = resolveIncludes(fs.readFileSync(htmlPath, "utf-8"), __dirname);
    return indexHtmlCache;
}

// Response helpers that always set the type and length.
function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}
function sendHtml(res, status, html) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    res.end(html);
}

// Buffer the raw request body up to the given limit.
function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on("data", chunk => {
            // Reject with 413 and stop accumulating when body exceeds limit.
            if (over) return;
            size += chunk.length;
            if (size > limit) {
                over = true;
                chunks.length = 0;
                reject(new HttpError(413, "payload too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
// Parse a JSON request body; empty body => {}.
async function readJsonBody(req, limit) {
    const buf = await readRawBody(req, limit);
    if (buf.length === 0) return {};
    try { return JSON.parse(buf.toString("utf-8")); }
    catch { throw new HttpError(400, "invalid JSON body"); }
}

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
};
// Serve a static file from root directory, rejecting path traversal and dotfiles.
function sendStatic(res, root, filename) {
    if (!filename || filename.startsWith(".") || filename.includes("/") || filename.includes("\\")) {
        throw new HttpError(404, "not found");
    }
    const full = path.join(root, filename);
    if (path.dirname(full) !== root) throw new HttpError(404, "not found"); // defense in depth
    let data;
    try { data = fs.readFileSync(full); }
    catch { throw new HttpError(404, "not found"); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
}

// ── route handlers ───────────────────────────────────────────────────
// HTTP proxy for the dashboard: forwards the method, body and a few headers to the ?url=
// target and relays its status, since the agents send no CORS headers.
async function handleProxy(req, res, url) {
    const target = url.searchParams.get("url");
    if (!target) throw new HttpError(400, "url query param required");

    const forwardHeaders = {};
    for (const name of ["api-key", "content-type", "accept"]) {
        const val = req.headers[name];
        if (val) forwardHeaders[name] = val;
    }
    const bodyBuf = await readRawBody(req, MAX_BODY);
    const hasBody = bodyBuf.length > 0;

    let r;
    try {
        r = await fetch(target, {
            method: req.method,
            headers: forwardHeaders,
            body: hasBody ? bodyBuf : undefined,
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new HttpError(502, `Could not reach target: ${e.message}`);
    }

    const text = await r.text();
    if ((r.headers.get("content-type") || "").includes("application/json")) {
        try { return sendJson(res, r.status, JSON.parse(text)); } catch { /* fall through */ }
    }
    return sendJson(res, r.status, { text });
}

// Saves the agent the dashboard is pointed at (selected_agent in lab-config.json).
async function handleSaveConfig(req, res) {
    const body = await readJsonBody(req, MAX_BODY);
    const data = readConfig();
    // The wire format keeps api_host/api_port (the dashboard's field names); on disk they
    // are the `selected_agent` section of this project's own file.
    if ("api_host" in body || "api_port" in body || "api_key" in body) {
        const sel = data.selected_agent || {};
        if ("api_host" in body) sel.ip = stripScheme(body.api_host);
        if ("api_port" in body) sel.port = Number(body.api_port) || body.api_port;
        if ("api_key" in body) sel.api_key = body.api_key;
        data.selected_agent = sel;
    }
    try { writeConfig(data); sendJson(res, 200, { status: "success" }); }
    catch (e) { throw new HttpError(500, `Failed to save config: ${e.message}`); }
}

// GET /api/servers: the saved agents, the shared file's mtime and the scan history.
function handleServersGet(res) {
    // The agent list lives in the shared file, so that is the one whose mtime says whether
    // it changed (another project may have updated it since this page loaded).
    const lastModified = fs.existsSync(SHARED_FILE) ? fs.statSync(SHARED_FILE).mtimeMs / 1000 : null;
    sendJson(res, 200, { servers: loadServers(), last_modified: lastModified, online_agents: loadOnlineAgents() });
}
// POST /api/servers: adds or updates one agent and marks it online.
async function handleServersPost(req, res) {
    const body = await readJsonBody(req, MAX_BODY);
    const url = ((body.url || "").trim()).replace(/\/+$/, "");
    if (!url) throw new HttpError(400, "url is required");
    const apiKey = "api_key" in body ? body.api_key : null;
    let servers = upsertServer(url, apiKey, (body.name || "").trim());
    // No key sent and none saved: store the default key if the agent accepts it, as a scan does.
    if (apiKey === null && !servers.find(s => s.url === url)?.api_key && await defaultKeyWorks(url)) {
        servers = upsertServer(url, DEFAULT_AGENT_KEY, "");
    }

    let online = loadOnlineAgents() || [];
    if (!online.includes(url)) {
        online.push(url);
        saveOnlineAgents(online);
    }
    
    sendJson(res, 200, { servers, online_agents: loadOnlineAgents() });
}
// DELETE /api/servers: the URL comes from the query or the JSON body.
async function handleServersDelete(req, res, url) {
    let target = url.searchParams.get("url");
    if (!target) {
        const body = await readJsonBody(req, MAX_BODY).catch(() => ({}));
        target = body.url;
    }
    const cleanUrl = ((target || "").trim()).replace(/\/+$/, "");
    if (!cleanUrl) throw new HttpError(400, "url is required");
    const servers = deleteServer(cleanUrl);
    sendJson(res, 200, { servers, online_agents: loadOnlineAgents() });
}

const DEFAULT_AGENT_KEY = "your-secret-key";   // agents' out-of-the-box Api-Key

// Sweep the local /24 subnet for agents answering GET /hello.
// Updates online agents and saves new agents with default key if verified.
const SCAN_TIMEOUT = 1500;   // /hello timeout during a /24 sweep
const SCAN_BATCH = 48;       // hosts probed at once

async function scanSubnet(port = 8314, announce = false, onFound = () => {}) {
    const localIp = await detectLocalIp();
    const prefix = localIp.split(".").slice(0, 3).join(".");
    if (announce) console.log(`scanning: ${prefix}.0/24 (port ${port})`);
    const saved = new Map(loadServers().map(server => [server.url, server]));
    const found = [];
    const names = {};   // url -> agent name from its /hello response
    const hosts = Array.from({ length: 255 }, (_, i) => `${prefix}.${i + 1}`);
    // Probe timeout and concurrency tuned for low-power boards (Zero 2 W / Pico).
    await runLimited(hosts, SCAN_BATCH, async host => {
        try {
            const r = await fetch(`http://${host}:${port}/hello`, { signal: AbortSignal.timeout(SCAN_TIMEOUT) });
            if (r.status === 200) {
                const u = `http://${host}:${port}`;
                found.push(u);
                try { names[u] = ((await r.json()).name || "").trim(); } catch { /* non-JSON hello */ }
                onFound({ url: u, name: names[u] || "", api_key: saved.get(u)?.api_key ?? DEFAULT_AGENT_KEY });
            }
        } catch { /* unreachable */ }
    });

    const storedKey = new Map(loadServers().map(s => [s.url, s.api_key || ""]));
    for (const u of found) {
        // Preserve saved key; for new agents, store default key only if verified.
        const key = storedKey.get(u)
            ? null
            : (await defaultKeyWorks(u)) ? DEFAULT_AGENT_KEY : "";
        upsertServer(u, key, names[u]);
    }
    saveOnlineAgents(found);
    return { subnet: `${prefix}.0/24`, found: [...found].sort(), names };
}

// True when the agent accepts the shipped default key on an authenticated route.
async function defaultKeyWorks(baseUrl) {
    try {
        const r = await fetch(`${baseUrl}/config/read`, {
            headers: { "Api-Key": DEFAULT_AGENT_KEY },
            signal: AbortSignal.timeout(2000),
        });
        return r.status === 200;
    } catch {
        return false;
    }
}

// GET /api/scan: with stream=1 it answers NDJSON, one "agent" event per find and a
// final "done", so the page can connect before the sweep ends.
async function handleScan(req, res, url) {
    const port = parseInt(url.searchParams.get("port") ?? "8314", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Invalid port");
    if (url.searchParams.get("stream") === "1") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
        try {
            const result = await scanSubnet(port, false, agent => emit({ type: "agent", agent }));
            emit({ type: "done", ...result });
        } catch (error) {
            emit({ type: "error", error: error.message });
        } finally {
            res.end();
        }
        return;
    }
    let result;
    try { result = await scanSubnet(port); }
    catch { throw new HttpError(500, "Could not determine local network interface"); }
    sendJson(res, 200, result);
}

// ── request guard ───────────────────────────────────────────────────
// Against DNS rebinding: another domain pointed at this machine still sends its own name as
// Host. IP addresses, localhost, this machine's name (with or without .local) and the
// --host value pass; anything else is refused.
function hostAllowed(hostHeader, hostname = os.hostname()) {
    const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d+)?$/i.exec(String(hostHeader || ""));
    if (!match) return false;
    const name = (match[1] || match[2]).toLowerCase().replace(/\.$/, "");
    if (net.isIP(name) || name === "localhost") return true;
    const own = String(hostname || "").toLowerCase().replace(/\.local$/, "");
    if (own && (name === own || name === own + ".local")) return true;
    return name === String(HOST).toLowerCase();
}
function originHost(origin) {
    try { return new URL(origin).host; } catch { return null; }
}

// ── router ───────────────────────────────────────────────────────────
// Routes one request; any HttpError becomes a JSON {error} answer.
async function dispatch(req, res) {
    // Only the dashboard's own page may call it: no CORS headers, an allowed Host, and an
    // Origin (when sent) that matches the Host.
    if (!hostAllowed(req.headers.host)) {
        return sendJson(res, 403, { error: "Host not allowed. Open ctrlpi-lab by IP address or localhost." });
    }
    if (req.headers.origin && originHost(req.headers.origin) !== req.headers.host) {
        return sendJson(res, 403, { error: "Cross-origin request rejected" });
    }

    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const m = req.method;
    try {
        if (p === "/api/proxy/url") return await handleProxy(req, res, url); // any method
        if (p === "/" && m === "GET") {
            if (indexHtmlCache === null) loadIndexHtml();
            return sendHtml(res, 200, indexHtmlCache);
        }
        if (p === "/api/reload-cache" && m === "POST") { loadIndexHtml(); return sendJson(res, 200, { status: "reloaded" }); }
        if (p === "/api/default-config" && m === "GET") {
            let localNetworkPrefix = "";
            try { localNetworkPrefix = (await detectLocalIp()).split(".").slice(0, 3).join(".") + "."; }
            catch { /* The address can still be entered manually when offline. */ }
            return sendJson(res, 200, { ...getDefaultApiConfig(), local_network_prefix: localNetworkPrefix, dev_mode: process.env.NODE_ENV === "development" });
        }
        if (p === "/api/save-config" && m === "POST") return await handleSaveConfig(req, res);
        if (p === "/api/servers" && m === "GET") return handleServersGet(res);
        if (p === "/api/servers" && m === "POST") return await handleServersPost(req, res);
        if (p === "/api/servers" && m === "DELETE") return await handleServersDelete(req, res, url);
        if (p === "/api/scan" && m === "GET") return await handleScan(req, res, url);
        if (p.startsWith("/pages/") && m === "GET") return sendStatic(res, PAGES_DIR, decodeURIComponent(p.slice("/pages/".length)));
        throw new HttpError(404, "not found");
    } catch (err) {
        // JSON error response {error: detail}.
        if (res.headersSent) return;
        sendJson(res, err.status || 500, { error: err.detail || err.message || "error" });
    }
}

// ── utilities ────────────────────────────────────────────────────────
// The LAN address: a UDP socket "connected" to 8.8.8.8 (nothing is sent) shows the
// routing choice; offline, the first non-internal IPv4 interface is used instead.
function detectLocalIp() {
    return new Promise((resolve, reject) => {
        const fallback = () => {
            try {
                const ifaces = os.networkInterfaces();
                for (const list of Object.values(ifaces)) {
                    for (const iface of list || []) {
                        if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal && iface.address && !iface.address.startsWith("127.")) {
                            return resolve(iface.address);
                        }
                    }
                }
            } catch { /* ignore */ }
            reject(new Error("no network interface with an IPv4 address"));
        };

        const s = dgram.createSocket("udp4");
        s.once("error", () => {
            try { s.close(); } catch { /* ignore */ }
            fallback();
        });
        try {
            s.connect(80, "8.8.8.8", () => {
                try {
                    const ip = s.address().address;
                    s.close();
                    if (ip && ip !== "0.0.0.0" && !ip.startsWith("127.")) return resolve(ip);
                } catch {
                    try { s.close(); } catch { /* ignore */ }
                }
                fallback();
            });
        } catch {
            try { s.close(); } catch { /* ignore */ }
            fallback();
        }
    });
}

// Run an async worker over items with a bounded concurrency.
async function runLimited(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const item = items[i++]; await worker(item); }
    });
    await Promise.all(runners);
}

// ── start ────────────────────────────────────────────────────────────
loadIndexHtml();
const server = http.createServer((req, res) => {
    dispatch(req, res).catch(err => {
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.detail || err.message || "error" });
    });
});
// Scan once at startup so the agent list is current without anyone pressing Scan. It runs
// after the listen callback and never blocks it: the dashboard is up immediately, and the
// list fills in when the sweep finishes.
async function startupScan() {
    try {
        try {
            const stats = await fs.promises.stat(SHARED_FILE);
            if (Date.now() - stats.mtimeMs < 5 * 60 * 1000) {
                console.log("Startup scan skipped: agents-config.json was updated less than 5 minutes ago. Running quick reachability test.");
                const saved = loadServers();
                const alive = [];
                await Promise.all(saved.map(async s => {
                    try {
                        const r = await fetch(`${s.url}/hello`, { signal: AbortSignal.timeout(1500) });
                        if (r.status === 200) alive.push(s.url);
                    } catch (e) { }
                }));
                saveOnlineAgents(alive);
                return;
            }
        } catch (e) {
            // File might not exist yet, proceed with scan
        }

        const { found } = await scanSubnet(DEFAULT_AGENT_PORT, true);
        console.log(found.length
            ? `Startup scan: ${found.length} agent(s) found - ${found.join(", ")}`
            : "Startup scan: no agents found on this subnet.");
    } catch (e) {
        console.log(`Startup scan skipped: ${e.message}`);
    }
}

server.listen(PORT, HOST, () => {
    const localAddr = `http://localhost:${server.address().port}`;
    const divider = "-".repeat(Math.max(21, localAddr.length));
    console.log(`\nctrlPi Lab started on →\n${divider}\n${localAddr}\n${divider}`);
    if (!NO_OPEN) openBrowser(localAddr);
    if (!NO_STARTUP_SCAN) startupScan();
});
// Closes the server, forcing the exit after one second if connections linger.
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A parent process can request graceful shutdown over IPC (also works on Windows).
if (process.send) process.on("message", message => {
    if (message === "shutdown") shutdown();
});
