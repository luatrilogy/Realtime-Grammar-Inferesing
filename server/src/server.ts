import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  InitializeParams,
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  Position,
  Range,
  TextDocumentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// --- Types for our tiny grammar model ---
type Prod = { lhs: string; rhs: string[]; line: number };
type Grammar = {
  start: string | null;
  prods: Prod[];
  defined: Set<string>;
  used: Set<string>;
};

// --- LSP bootstrap ---
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams) => {
  return {
    capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental },
  };
});

documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
  const text = change.document.getText();
  const diags: Diagnostic[] = [];
  try {
    const g = parseGrammar(text);

    // undefined nonterminals (used but never defined)
    for (const u of g.used) {
      if (!g.defined.has(u)) {
        const loc = findFirstOccurrence(text, u);
        diags.push(makeDiag(`Undefined nonterminal '${u}'`, DiagnosticSeverity.Error, loc));
      }
    }

    // unreachable nonterminals
    for (const u of findUnreachable(g)) {
      const loc = findLhsLocation(text, u);
      diags.push(makeDiag(`Unreachable nonterminal '${u}'`, DiagnosticSeverity.Warning, loc));
    }

    // direct left recursion: A -> A ...
    for (const p of g.prods) {
      if (p.rhs.length > 0 && p.rhs[0] === p.lhs) {
        const loc: { start: Position; end: Position } = {
          start: { line: p.line, character: 0 },
          end: { line: p.line, character: 80 },
        };
        diags.push(makeDiag(`Direct left recursion on '${p.lhs}'`, DiagnosticSeverity.Error, loc));
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    diags.push(makeDiag(`Parse error: ${msg}`, DiagnosticSeverity.Error, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }));
  }

  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: diags });
});

documents.listen(connection);
connection.listen();

// --- Helpers ---

function makeDiag(
  message: string,
  severity: DiagnosticSeverity,
  range: { start: Position; end: Position }
): Diagnostic {
  return { message, severity, range };
}

// very tiny grammar format:
//
// start: S;
// A -> B c | d
//
function parseGrammar(text: string): Grammar {
  const lines = text.split(/\r?\n/);
  const prods: Prod[] = [];
  let start: string | null = null;
  const defined = new Set<string>();
  const used = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

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
        for (const t of tokens) if (isNonterminal(t)) used.add(t);
      }
    }
  }

  return { start, prods, defined, used };
}

function tokenize(s: string): string[] {
  if (!s) return [];
  const raw = s.split(/\s+/).map(x => x.trim()).filter(Boolean);
  return raw.filter(x => x !== 'ε' && x.toLowerCase() !== 'epsilon');
}

function isNonterminal(tok: string): boolean {
  return /^[A-Z]/.test(tok);
}

function findUnreachable(g: Grammar): string[] {
  const start = g.start || Array.from(g.defined)[0];
  if (!start) return [];
  const adj = new Map<string, Set<string>>();
  for (const p of g.prods) {
    if (!adj.has(p.lhs)) adj.set(p.lhs, new Set());
    for (const t of p.rhs) if (isNonterminal(t)) adj.get(p.lhs)!.add(t);
  }
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length) {
    const v = stack.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    const ns = adj.get(v);
    if (ns) for (const w of ns) stack.push(w);
  }
  const unreachable: string[] = [];
  for (const d of g.defined) if (!seen.has(d)) unreachable.push(d);
  return unreachable;
}

function findFirstOccurrence(text: string, word: string): { start: Position; end: Position } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(word);
    if (idx >= 0) {
      return { start: { line: i, character: idx }, end: { line: i, character: idx + word.length } };
    }
  }
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

function findLhsLocation(text: string, lhs: string): { start: Position; end: Position } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(lhs + ' ->') || t.startsWith(lhs + ' →')) {
      return { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } };
    }
  }
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}