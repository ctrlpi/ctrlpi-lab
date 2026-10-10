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

export function dashboard(fetch) {
    const elements = new Map();
    const element = () => ({
        value: '', _html: '', style: {}, children: [],
        get innerHTML() { return this._html; },
        set innerHTML(value) { this._html = value; this.children = []; },
        get textContent() { return this._html.replace(/<[^>]*>/g, ''); },
        set textContent(value) { this._html = String(value); this.children = []; },
        classList: { add() {}, remove() {}, contains() { return false; } },
        appendChild(child) { this.children.push(child); },
        setAttribute() {}, close() { this.closed = true; },
        showModal() {}, focus() {},
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    });
    const get = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const context = vm.createContext({
        console, URL, fetch, AbortSignal, TextDecoder,
        setInterval() { return 1; }, clearInterval() {},
        setTimeout() { return 1; }, clearTimeout() {},
        localStorage: { getItem() { return null; }, setItem() {} },
        window: { addEventListener() {} },
        document: {
            addEventListener() {}, getElementById: get,
            createElement: element, querySelector() { return null; },
            querySelectorAll() { return []; },
        },
    });
    for (const [index, script] of scripts.entries()) {
        vm.runInContext(script, context, { filename: `dashboard-${index}.js` });
    }
    return { context, get, evaluate: code => vm.runInContext(code, context) };
}

