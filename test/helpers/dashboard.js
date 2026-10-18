import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function assemble(file) {
    return fs.readFileSync(file, 'utf8').replace(/<!--INCLUDE:([^>]+)-->/g,
        (_, relative) => assemble(path.join(root, relative.trim())));
}
const html = assemble(path.join(root, 'pages/main.html'));
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]);

export function dashboard(fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })) {
    const elements = new Map();
    const element = () => ({
        value: '', _html: '', style: {}, children: [], dataset: {},
        get innerHTML() { return this._html; },
        set innerHTML(value) { this._html = value; this.children = []; },
        get textContent() { return this._html.replace(/<[^>]*>/g, ''); },
        set textContent(value) { this._html = String(value); this.children = []; },
        classList: {
            _classes: new Set(),
            add(c) { this._classes.add(c); },
            remove(c) { this._classes.delete(c); },
            contains(c) { return this._classes.has(c); },
            toggle(c, force) {
                if (force !== undefined) {
                    if (force) this.add(c); else this.remove(c);
                    return force;
                }
                if (this.contains(c)) { this.remove(c); return false; }
                this.add(c); return true;
            }
        },
        appendChild(child) { this.children.push(child); },
        setAttribute() {}, close() { this.closed = true; },
        showModal() {}, focus() {},
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    });
    const get = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const body = element();
    const context = vm.createContext({
        console, URL, fetch, AbortSignal, TextDecoder,
        setInterval() { return 1; }, clearInterval() {},
        setTimeout() { return 1; }, clearTimeout() {},
        localStorage: { getItem() { return null; }, setItem() {} },
        window: { addEventListener() {} },
        document: {
            addEventListener() {}, getElementById: get,
            createElement: element, querySelector() { return element(); },
            querySelectorAll() { return []; },
            body,
        },
    });
    for (const [index, script] of scripts.entries()) {
        vm.runInContext(script, context, { filename: `dashboard-${index}.js` });
    }
    return { context, get, evaluate: code => vm.runInContext(code, context) };
}

