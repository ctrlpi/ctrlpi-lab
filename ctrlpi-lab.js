#!/usr/bin/env node
// Served on Node's built-in http module with zero external dependencies.
import http from "http";
import { spawn, execFile } from "child_process";
import dgram from "dgram";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
//   config.json      shared agent list ({name, ip, port, api_key}) across ctrlPi tools
//   lab-config.json  dashboard state: selected_agent, mcp configuration, online_agents
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

const CONFIG_FILE = resolveConfigFile("lab-config.json");
const SHARED_FILE = path.join(path.dirname(CONFIG_FILE), "config.json");
const STATE_DIR = path.dirname(CONFIG_FILE);
const PAGES_DIR = path.join(__dirname, "pages");
const IMAGES_DIR = path.join(__dirname, "images");
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
class HttpError extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

// Reads lab-config.json (selected_agent, mcp, online_agents).
function readConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch { /* fall through */ }
    }
    return {};
}
function writeConfig(data) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// Reads shared config.json (agents list).
function readShared() {
    if (fs.existsSync(SHARED_FILE)) {
        try { return JSON.parse(fs.readFileSync(SHARED_FILE, "utf-8")); } catch { /* fall through */ }
    }
    return {};
}
function writeSharedAgents(agents) {
    const shared = readShared();
    shared.agents = agents;
    fs.writeFileSync(SHARED_FILE, JSON.stringify(shared, null, 2));
}

// ── config: agents / scan results ────────────────────────────────────
function stripScheme(v) {
    return String(v || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// Agent records use {name, ip, port, api_key}. Default agent port is 8314.
const DEFAULT_AGENT_PORT = 8314;

function agentToUrl(a) {
    if (!a || !a.ip) return "";
    const host = /:\/\//.test(a.ip) ? a.ip : `http://${a.ip}`;
    return `${host}:${a.port || DEFAULT_AGENT_PORT}`;
}
function urlToAgent(url, api_key = "", name = "") {
    let host = String(url || "").trim().replace(/\/+$/, "");
    let port = DEFAULT_AGENT_PORT;
    const m = host.match(/^(.*?):(\d+)$/);
    if (m && !/^https?:$/i.test(m[1])) { host = m[1]; port = Number(m[2]); }
    const ip = host.replace(/^http:\/\//i, "");
    // mcp-bridge identifies agents by name; omit when not specified.
    return { ...(name ? { name } : {}), ip, port, api_key: api_key || "" };
}

// Loads [{url, api_key, name?}] from shared config.json.
function loadServers() {
    const raw = readShared().agents;
    return (Array.isArray(raw) ? raw : [])
        .map(a => ({ url: agentToUrl(a), api_key: a.api_key || "", ...(a.name ? { name: a.name } : {}) }))
        .filter(s => s.url);
}
function saveServers(servers) {
    const merged = {};
    for (const s of servers) if (s.url) merged[s.url] = s;
    const agents = Object.keys(merged).sort()
        .map(u => urlToAgent(u, merged[u].api_key, merged[u].name));
    try { writeSharedAgents(agents); } catch { /* best effort */ }
}
// apiKey=null preserves an existing key (scan rediscovery); "" clears it.
// name: agent name from /hello - stored when non-empty, preserved otherwise.
function upsertServer(url, apiKey, name) {
    const byUrl = {};
    for (const s of loadServers()) byUrl[s.url] = s;
    const existing = byUrl[url] || { url, api_key: "" };
    if (apiKey !== null && apiKey !== undefined) existing.api_key = apiKey;
    if (name) existing.name = name;
    byUrl[url] = existing;
    saveServers(Object.values(byUrl));
    return loadServers();
}
// Returns online agents from the most recent scan snapshot as URLs, or null if no scan has run.
function loadOnlineAgents() {
    const data = readConfig();
    if (!("online_agents" in data)) return null;
    const list = data.online_agents;
    return Array.isArray(list) ? list.map(e => `http://${stripScheme(e)}`) : list;
}
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

function getDefaultApiConfig() {
    let mcpUrl = "http://localhost:8315";
    let mcpKey = process.env.MCP_API_KEY;

    const data = readConfig();
    const sel = loadSelected();
    // Format agent target as URL for the dashboard.
    const apiHost = `http://${sel.ip}`;
    const apiPort = sel.port;
    const apiKey = process.env.API_KEY || sel.api_key;
    const mcp = data.mcp || {};
    if (mcp.ip) mcpUrl = `http://${stripScheme(mcp.ip)}:${mcp.port || 8315}`;
    else if (mcp.url) mcpUrl = mcp.url;
    if (!mcpKey) mcpKey = mcp.api_key;

    return {
        api_key: apiKey || "your-secret-key",
        api_host: apiHost,
        api_port: apiPort,
        api_url: `${apiHost}:${apiPort}`,
        mcp: { url: mcpUrl, api_key: mcpKey || "your-mcp-key" },
    };
}

// ── merged dashboard HTML (recursive <!--INCLUDE:--> + in-memory cache) ─
function resolveIncludes(html, baseDir, depth = 0) {
    if (depth > 10) return html;
    return html.replace(/<!--INCLUDE:([^>]+)-->/g, (_m, rel) => {
        const p = path.join(baseDir, rel.trim());
        try { return resolveIncludes(fs.readFileSync(p, "utf-8"), baseDir, depth + 1); }
        catch { return `<!-- INCLUDE NOT FOUND: ${rel} -->`; }
    });
}
let indexHtmlCache = null;
function loadIndexHtml() {
    const htmlPath = path.join(PAGES_DIR, "main.html");
    if (!fs.existsSync(htmlPath)) throw new HttpError(404, "pages/main.html file not found");
    indexHtmlCache = resolveIncludes(fs.readFileSync(htmlPath, "utf-8"), __dirname);
    return indexHtmlCache;
}

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
// General HTTP proxy - forwards any method/body to the ?url= target, relaying the
// Mcp-Session-Id response header the MCP Streamable HTTP transport relies on.
async function handleProxy(req, res, url) {
    const target = url.searchParams.get("url");
    if (!target) throw new HttpError(400, "url query param required");

    const forwardHeaders = {};
    for (const name of ["api-key", "content-type", "accept", "mcp-session-id"]) {
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

    const sessionId = r.headers.get("mcp-session-id");
    if (sessionId) res.setHeader("Mcp-Session-Id", sessionId);

    const text = await r.text();
    if ((r.headers.get("content-type") || "").includes("application/json")) {
        try { return sendJson(res, r.status, JSON.parse(text)); } catch { /* fall through */ }
    }
    return sendJson(res, r.status, { text });
}

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
    // The MCP tab sends one URL; on disk it is ip + port, matching agents[] and selected.
    const setMcpUrl = (mcp, url) => {
        const bare = stripScheme(url);
        const m = bare.match(/^(.*?):(\d+)$/);
        mcp.ip = m ? m[1] : bare;
        mcp.port = m ? Number(m[2]) : 8315;
        delete mcp.url;
    };
    if (body.mcp && typeof body.mcp === "object") {
        const mcp = data.mcp || {};
        if ("url" in body.mcp) setMcpUrl(mcp, body.mcp.url);
        if ("api_key" in body.mcp) mcp.api_key = body.mcp.api_key;
        data.mcp = mcp;
    }
    if ("mcp_url" in body || "mcp_api_key" in body) {
        const mcp = data.mcp || {};
        if ("mcp_url" in body) setMcpUrl(mcp, body.mcp_url);
        if ("mcp_api_key" in body) mcp.api_key = body.mcp_api_key;
        data.mcp = mcp;
    }
    try { writeConfig(data); sendJson(res, 200, { status: "success" }); }
    catch (e) { throw new HttpError(500, `Failed to save config: ${e.message}`); }
}

async function handleLogs(req, res, url) {
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "300", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 300;
    const search = url.searchParams.get("search");
    const category = url.searchParams.get("category");

    const config = getDefaultApiConfig();
    let data;
    try {
        const r = await fetch(`${config.api_url}/logs`, {
            headers: { "Api-Key": config.api_key },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new HttpError(r.status, `Pi error: ${r.status}`);
        data = await r.json();
    } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `Could not reach Pi: ${e.message}`);
    }

    const filtered = (data.logs || []).filter(line => {
        if (!line) return false;
        if (search && !line.toLowerCase().includes(String(search).toLowerCase())) return false;
        if (category && category !== "ALL" && !line.includes(`[${category}]`)) return false;
        return true;
    });
    sendJson(res, 200, { logs: filtered.slice(-limit) });
}

function handleServersGet(res) {
    // The agent list lives in the shared file, so that is the one whose mtime says whether
    // it changed (another project may have updated it since this page loaded).
    const lastModified = fs.existsSync(SHARED_FILE) ? fs.statSync(SHARED_FILE).mtimeMs / 1000 : null;
    sendJson(res, 200, { servers: loadServers(), last_modified: lastModified, online_agents: loadOnlineAgents() });
}
async function handleServersPost(req, res) {
    const body = await readJsonBody(req, MAX_BODY);
    const url = ((body.url || "").trim()).replace(/\/+$/, "");
    if (!url) throw new HttpError(400, "url is required");
    const apiKey = "api_key" in body ? body.api_key : null;
    const servers = upsertServer(url, apiKey, (body.name || "").trim());
    
    let online = loadOnlineAgents() || [];
    if (!online.includes(url)) {
        online.push(url);
        saveOnlineAgents(online);
    }
    
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

// ── router ───────────────────────────────────────────────────────────
async function dispatch(req, res) {
    // CORS: allow all for local dashboard development.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

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
        if (p === "/api/logs" && m === "GET") return await handleLogs(req, res, url);
        if (p === "/api/servers" && m === "GET") return handleServersGet(res);
        if (p === "/api/servers" && m === "POST") return await handleServersPost(req, res);
        if (p === "/api/scan" && m === "GET") return await handleScan(req, res, url);
        if (p.startsWith("/images/") && m === "GET") return sendStatic(res, IMAGES_DIR, decodeURIComponent(p.slice("/images/".length)));
        if (p.startsWith("/pages/") && m === "GET") return sendStatic(res, PAGES_DIR, decodeURIComponent(p.slice("/pages/".length)));
        throw new HttpError(404, "not found");
    } catch (err) {
        // JSON error response {error: detail}.
        if (res.headersSent) return;
        sendJson(res, err.status || 500, { error: err.detail || err.message || "error" });
    }
}

// ── utilities ────────────────────────────────────────────────────────
function detectLocalIp() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket("udp4");
        s.once("error", e => { try { s.close(); } catch { /* ignore */ } reject(e); });
        try {
            s.connect(80, "8.8.8.8", () => {
                try { const ip = s.address().address; s.close(); resolve(ip); }
                catch (e) { try { s.close(); } catch { /* ignore */ } reject(e); }
            });
        } catch (e) { try { s.close(); } catch { /* ignore */ } reject(e); }
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
                console.log("Startup scan skipped: config.json was updated less than 5 minutes ago. Running quick reachability test.");
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
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A parent process can request graceful shutdown over IPC (also works on Windows).
if (process.send) process.on("message", message => {
    if (message === "shutdown") shutdown();
});
