"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
// --- LSP bootstrap ---
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
connection.onInitialize((_params) => {
    return {
        capabilities: { textDocumentSync: node_1.TextDocumentSyncKind.Incremental },
    };
});
documents.onDidChangeContent((change) => {
    const text = change.document.getText();
    const diags = [];
    try {
        const g = parseGrammar(text);
        // undefined nonterminals (used but never defined)
        for (const u of g.used) {
            if (!g.defined.has(u)) {
                const loc = findFirstOccurrence(text, u);
                diags.push(makeDiag(`Undefined nonterminal '${u}'`, node_1.DiagnosticSeverity.Error, loc));
            }
        }
        // unreachable nonterminals
        for (const u of findUnreachable(g)) {
            const loc = findLhsLocation(text, u);
            diags.push(makeDiag(`Unreachable nonterminal '${u}'`, node_1.DiagnosticSeverity.Warning, loc));
        }
        // direct left recursion: A -> A ...
        for (const p of g.prods) {
            if (p.rhs.length > 0 && p.rhs[0] === p.lhs) {
                const loc = {
                    start: { line: p.line, character: 0 },
                    end: { line: p.line, character: 80 },
                };
                diags.push(makeDiag(`Direct left recursion on '${p.lhs}'`, node_1.DiagnosticSeverity.Error, loc));
            }
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diags.push(makeDiag(`Parse error: ${msg}`, node_1.DiagnosticSeverity.Error, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }));
    }
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics: diags });
});
documents.listen(connection);
connection.listen();
// --- Helpers ---
function makeDiag(message, severity, range) {
    return { message, severity, range };
}
// very tiny grammar format:
//
// start: S;
// A -> B c | d
//
function parseGrammar(text) {
    const lines = text.split(/\r?\n/);
    const prods = [];
    let start = null;
    const defined = new Set();
    const used = new Set();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#'))
            continue;
        const startMatch = line.match(/^start\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*;?/);
        if (startMatch) {
            start = startMatch[1];
            continue;
        }
        // A -> B c | d    (also allow unicode arrow →)
        const arrowMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|→)\s*(.+)$/);
        if (arrowMatch) {
            const lhs = arrowMatch[1];
            defined.add(lhs);
            const rhsAlt = arrowMatch[2].split('|');
            for (const alt of rhsAlt) {
                const tokens = tokenize(alt.trim());
                prods.push({ lhs, rhs: tokens, line: i });
                for (const t of tokens)
                    if (isNonterminal(t))
                        used.add(t);
            }
        }
    }
    return { start, prods, defined, used };
}
function tokenize(s) {
    if (!s)
        return [];
    const raw = s.split(/\s+/).map(x => x.trim()).filter(Boolean);
    return raw.filter(x => x !== 'ε' && x.toLowerCase() !== 'epsilon');
}
function isNonterminal(tok) {
    return /^[A-Z]/.test(tok);
}
function findUnreachable(g) {
    const start = g.start || Array.from(g.defined)[0];
    if (!start)
        return [];
    const adj = new Map();
    for (const p of g.prods) {
        if (!adj.has(p.lhs))
            adj.set(p.lhs, new Set());
        for (const t of p.rhs)
            if (isNonterminal(t))
                adj.get(p.lhs).add(t);
    }
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
        const v = stack.pop();
        if (seen.has(v))
            continue;
        seen.add(v);
        const ns = adj.get(v);
        if (ns)
            for (const w of ns)
                stack.push(w);
    }
    const unreachable = [];
    for (const d of g.defined)
        if (!seen.has(d))
            unreachable.push(d);
    return unreachable;
}
function findFirstOccurrence(text, word) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf(word);
        if (idx >= 0) {
            return { start: { line: i, character: idx }, end: { line: i, character: idx + word.length } };
        }
    }
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}
function findLhsLocation(text, lhs) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith(lhs + ' ->') || t.startsWith(lhs + ' →')) {
            return { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } };
        }
    }
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}
//# sourceMappingURL=server.js.map