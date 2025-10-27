import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as cp from 'child_process';
import { spawn } from 'child_process';
import * as  fs from 'fs'

let client: LanguageClient | undefined;
let previewTimer: NodeJS.Timeout | undefined;
let currentProc: ReturnType<typeof spawn> | undefined;
let lastPreviewMetrics: any = undefined;
let vizPanel: vscode.WebviewPanel | undefined;
let lastMetrics: any = undefined;
const UNCOVERED_DECOR = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
  light: { backgroundColor: 'rgba(255,200,0,0.15)' },
  dark:  { backgroundColor: 'rgba(255,200,0,0.10)' },
});


function getcfg<T = any>(key: string, def?: T): T {
  return (vscode.workspace.getConfiguration('utaGrammarLab').get(key) as T) ?? (def as T);
}

function isGrammarFileName(fileName: string): boolean {
  return /\.gram$/i.test(fileName) || fileName.toLowerCase().endsWith('.gramdsl');
}
function looksLikeGrammarText(text: string): boolean {
  const head = text.slice(0, 4000);
  return /(^|\n)\s*start\s*:/i.test(head) && /(^|\n)\s*[A-Z][A-Za-z0-9_]*\s*->/.test(head);
}
async function showInNewGrammarDoc(grammarText: string, status = 'Inferred grammar') {
  const doc = await vscode.workspace.openTextDocument({ content: grammarText, language: 'gramdsl' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  vscode.window.setStatusBarMessage(status, 4000);
}

async function runAndShowInference(corpus: string, context: vscode.ExtensionContext) {
  const cfg       = vscode.workspace.getConfiguration('utaGrammarLab');
  const py        = cfg.get<string>('pythonPath', 'python')!;
  const scriptRel = cfg.get<string>('inferScript', 'python/infer_backend.py')!;
  const timeout   = cfg.get<number>('inferTimeoutSec', 10)!;
  const scriptAbs = path.join(context.extensionPath, scriptRel);

  vscode.window.setStatusBarMessage('Running grammar inference…', 2500);

  // call backend
  const res = await runPythonJSON(py, scriptAbs, { corpus, options: {} }, timeout);
  
  lastMetrics = res.metrics; // store latest metrics for reuse
  if (vizPanel) {
    vizPanel.webview.postMessage({ type: 'METRICS', data: lastMetrics });
  }

  const m = (res && res.metrics) || {};
  if (vizPanel) {
    vizPanel.webview.postMessage({ type: 'METRICS', data: res.metrics ?? {} });
    vizPanel.webview.postMessage({ type: 'GRAMMAR_TEXT', text: String(res.grammar || ''), status: 'Inferred' });
  }

  const ops = Array.isArray(m.unique_ops) ? m.unique_ops.join(' ') : '';
  const kws = Array.isArray(m.has_keywords) ? m.has_keywords.join(' ') : '';
  const header =
    `// Inference metrics\n` +
    `// tokens: ${m.num_tokens ?? '?'}\n` +
    `// operators: ${ops || '(none)'}\n` +
    `// keywords: ${kws || '(none)'}\n\n`;

  const grammarText = String(res.grammar || '');
  await showInNewGrammarDoc(header + grammarText, 'Inferred grammar (new document)');

  // ---- NEW: status bar summary ----
  vscode.window.setStatusBarMessage(
    `Grammar inferred • tokens=${m.num_tokens ?? '?'} • ops=[${ops}] • kw=[${kws}]`,
    5000
  );
}

// run python script that speaks JSON over stdin/stdout
function runPythonJSON(pythonPath: string, scriptPath: string, payload: any, timeoutSec: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const proc = cp.spawn(pythonPath, [scriptPath], { cwd });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} ; reject(new Error(`Inference timed out after ${timeoutSec}s`)); }, Math.max(1, timeoutSec) * 1000);
    proc.stdout?.on('data', d => out += d.toString());
    proc.stderr?.on('data', d => err += d.toString());
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`Failed to start Python: ${String(e)}`)); });
    proc.on('close', _ => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out || '{}');
        if (json.error) reject(new Error(json.error + (err ? `\n${err}` : '')));
        else resolve(json);
      } catch (e: any) {
        reject(new Error(`Invalid JSON from backend.\nSTDERR:\n${err}\nSTDOUT:\n${out}\nParseError: ${e.message}`));
      }
    });
    proc.stdin?.write(JSON.stringify(payload));
    proc.stdin?.end();
  });
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/;
const NUM_RE   = /(?:0|[1-9][0-9]*)/;
const STR_RE   = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/;

const TOKENS_RE = new RegExp(
  [
    STR_RE.source,
    IDENT_RE.source,
    NUM_RE.source,
    // common operators & punct you already infer in backend
    '==|!=|<=|>=|&&|\\|\\||\\+=|-=|\\*=|/=|%=|\\+\\+|--|->|::|<<|>>|<|>|=|\\+|-|\\*|/|%|\\^|&|\\||~|!',
    '[(){}\\[\\];,.:?]'
  ].join('|'),
  'g'
);

function extractQuotedTerminalsFromGrammar(gram: string): Set<string> {
  // Collect everything inside single quotes: 'if', 'while', '+', '==', etc.
  const set = new Set<string>();
  const rx = /'([^'\\]|\\.)+'/g;
  for (const m of gram.matchAll(rx)) {
    // drop the surrounding quotes
    const raw = m[0].slice(1, -1);
    set.add(raw);
  }
  return set;
}

function rand<T>(xs: T[]) { return xs[Math.floor(Math.random() * xs.length)]; }
function chance(p: number) { return Math.random() < p; }

function pickWeighted<T>(pairs: Array<[T, number]>): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) {
    if ((r -= w) <= 0) return v;
  }
  return pairs[0][0];
}

function sampleID()  { return "x" + Math.floor(Math.random() * 100); }
function sampleNUM() { return String(1 + Math.floor(Math.random() * 9)); } // 1..9
function sampleSTR() { return `"s${Math.floor(Math.random() * 10)}"`; }

function splitTopLevel(rhs: string, sep = '|'): string[] {
  const out: string[] = []; let buf = '';
  let inSingle = false, inRegex = false, esc = false;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (esc) { buf += ch; esc = false; continue; }
    if (ch === '\\') { buf += ch; esc = true; continue; }
    if (inRegex) { if (ch === '/' && !esc) inRegex = false; buf += ch; continue; }
    if (inSingle){ if (ch === '\'' && !esc) inSingle = false; buf += ch; continue; }
    if (ch === '\''){ inSingle = true; buf += ch; continue; }
    if (ch === '/') { inRegex  = true; buf += ch; continue; }
    if (ch === sep) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function tokenizeAlt(alt: string): string[] {
  const toks: string[] = []; let buf = '';
  let inSingle = false, inRegex = false, esc = false;
  const flush = () => { if (buf.trim()) toks.push(buf.trim()); buf = ''; };
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i];
    if (esc) { buf += ch; esc = false; continue; }
    if (ch === '\\') { buf += ch; esc = true; continue; }
    if (inRegex) { buf += ch; if (ch === '/' && !esc) inRegex = false; continue; }
    if (inSingle){ buf += ch; if (ch === '\'' && !esc) inSingle = false; continue; }
    if (ch === '\''){ flush(); buf += ch; inSingle = true; continue; }
    if (ch === '/') { flush(); buf += ch; inRegex  = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    buf += ch;
  }
  flush();
  return toks;
}

function parseProductions(gram: string): Map<string, string[][]> {
  const rules = new Map<string, string[][]>();
  const cleaned = gram.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  const ruleRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|:)\s*(.+?);/gms;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cleaned))) {
    const lhs = m[1].trim();
    const alts = splitTopLevel(m[2])
      .map(a => tokenizeAlt(a))
      .filter(parts => parts.length > 0);
    const arr = rules.get(lhs) ?? [];
    arr.push(...alts);
    rules.set(lhs, arr);
  }
  return rules;
}

function isQuoted(tok: string){ return /^'.*'$/.test(tok); }
function isRegex(tok: string) { return /^\/.*\/$/.test(tok); }
function isUpper(tok: string) { return /^[A-Z][A-Za-z0-9_]*$/.test(tok); }

function pickAlt(alts: string[][], lhs: string, depth: number): string[] {
  const nonEmpty = alts.filter(a => !(a.length === 1 && a[0] === "ε"));
  let pool = nonEmpty.length ? nonEmpty : alts;

  if (lhs === "AddExprTail" && nonEmpty.length) {
    if (Math.random() < 0.7) pool = nonEmpty;
  }

  const safe = pool.filter(a => a[0] !== lhs);
  pool = depth > 3 && safe.length ? safe : pool;

  const sorted = [...pool].sort((a, b) => a.length - b.length);
  return depth > 3 ? sorted[Math.floor(Math.random() * Math.ceil(sorted.length / 2))] : sorted[Math.floor(Math.random() * sorted.length)];
}

// minimal token you can always fall back to for a nonterminal
function minimalSampleFor(sym: string): string {
  // Tail nonterminals should default to ε when we bail out
  if (sym === "AddExprTail" || sym === "TermTail" || sym === "RelExprTail" || sym === "BitExprTail")
    return "";

  if (sym === "Expr" || sym === "AddExpr" || sym === "Factor") return sampleNUM();  // e.g., "7"
  if (sym === "Stmt") return `${sampleID()} = ${sampleNUM()}`;                       // e.g., "x12 = 3"
  return sampleID();
}

// ---- MAIN GENERATOR ----
export function generateFromGrammar(
  grammarText: string,
  startSymbol = "start",
  maxDepth = 6
): string {
  const rules = parseProductions(grammarText);

  function expand(sym: string, depth: number): string {
    // terminals
    if (sym === "ε") return "";                         
    if (isQuoted(sym)) return sym.slice(1, -1);
    if (isRegex(sym))  return sampleSTR();
    if (sym === "ID")  return sampleID();
    if (sym === "NUM") return sampleNUM();
    if (sym === "STR") return sampleSTR();
    if (sym === "Factor") {
      // choose among ID, NUM, STR, and parenthesized Expr (weighted)
      const choice = pickWeighted<"ID" | "NUM" | "STR" | "PAREN">([
        ["ID", 40],
        ["NUM", 30],
        ["STR", 15],
        ["PAREN", 15],
      ]);

      if (choice === "ID")  return sampleID();
      if (choice === "NUM") return sampleNUM();
      if (choice === "STR") return sampleSTR();

      // PAREN: only keep if the inner Expr isn't trivial
      const inner = expand("Expr", depth + 1);
      if (/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|".*")$/.test(inner)) {
        // fallback to non-paren token when inner is trivial
        return Math.random() < 0.5 ? sampleID() : sampleNUM();
      }
      return "(" + inner + ")";
    }

    // nonterminal
    const alts = rules.get(sym);
    if (!alts || !alts.length) {
      // unknown -> give something simple instead of empty
      return minimalSampleFor(sym);
    }

    if (depth > maxDepth) {
      // Prefer ε for common tail nonterminals to avoid "x63 x1"
      if (["AddExprTail","TermTail","RelExprTail","BitExprTail"].includes(sym)) return "";
      return minimalSampleFor(sym);
    }

    const chosen = pickAlt(alts, sym, depth);
    const parts = chosen.map(t => expand(t, depth + 1)).filter(s => s != null);
    let out = parts
      .join(" ")
      .replace(/\s+([;:),\]\}])/g, "$1")
      .replace(/([(\[\{])\s+/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    // kill any dangling lone quotes from weird alts
    out = out
      .replace(/\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, "$1") // (x12) -> x12
      .replace(/\(\s*(\d+)\s*\)/g, "$1")                    // (7) -> 7
      .replace(/\(\s*"([^"]*)"\s*\)/g, '"$1"');             // ("s3")-> "s3"
      
    return out.length ? out : minimalSampleFor(sym);
  }

  // Special-case: if we can see Stmt/StmtList rules, build 2–4 statements joined by ';'
  const hasStmt = rules.has("Stmt");
  const hasList = rules.has("StmtList");
  if (hasStmt && hasList) {
    const N = 2 + Math.floor(Math.random() * 3); // 2..4 stmts
    const stmts = Array.from({ length: N }, () => expand("Stmt", 0));
    return stmts.map(s => (s.trim().endsWith(";") ? s : s + ";")).join("\n");
  }

  // otherwise just expand from start (or first rule if 'start' missing)
  const hasStartKey = [...rules.keys()].find(k => k.toLowerCase() === startSymbol.toLowerCase());
  const start = hasStartKey || [...rules.keys()][0] || "start";
  return expand(start, 0);
}

export async function activate(ctx: vscode.ExtensionContext) {
  const serverModule = ctx.asAbsolutePath(path.join('out-server', 'server.js'));
  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
  };
  const clientOptions: LanguageClientOptions = { documentSelector: [{ language: 'gramdsl' }] };
  client = new LanguageClient('utaGrammarLsp', 'UTA Grammar LSP', serverOptions, clientOptions);
  await client.start();                           // start the LSP
  ctx.subscriptions.push({ dispose: () => client?.stop() });  // add a Disposable

  ctx.subscriptions.push(
    vscode.commands.registerCommand('uta.gram.visualize', () => openVisualizer(ctx)),
    vscode.commands.registerCommand('uta.infer.preview', () => runInference(ctx, true)),
    vscode.commands.registerCommand('uta.infer.full', () => runInference(ctx, false))
  );

  const cfg = vscode.workspace.getConfiguration('utaGrammarLab');
  const pythonPath = cfg.get<string>('pythonPath', 'python')!;
  const scriptRel  = cfg.get<string>('inferScript', 'python/infer_backend.py')!;
  const timeout    = cfg.get<number>('inferTimeoutSec', 10)!;
  const scriptAbs  = path.join(ctx.extensionPath, scriptRel);
  const tracesRel = cfg.get<string>('tracesDir') || 'examples';
  const pattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] || vscode.workspace.rootPath || '', `${tracesRel}/**/*.txt`);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(() => schedulePreview(ctx));
  watcher.onDidCreate(() => schedulePreview(ctx));
  watcher.onDidDelete(() => schedulePreview(ctx));
  ctx.subscriptions.push(watcher);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('utaGrammarLab.inferFromActive', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return vscode.window.showWarningMessage('Open a text/code file first.');

      const doc  = ed.document;
      const text = doc.getText();

      // BLOCK inference on .gram or grammar-looking text
      if (isGrammarFileName(doc.fileName) || looksLikeGrammarText(text)) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Pick a different file…', description: 'Choose a corpus or source file to infer from' },
            { label: 'Infer from selection anyway', description: 'Use the current selection as corpus' },
            { label: 'Cancel' }
          ],
          { placeHolder: 'This looks like a grammar file. What would you like to do?' }
        );
        if (!choice || choice.label === 'Cancel') return;

        if (choice.label === 'Pick a different file…') {
          await vscode.commands.executeCommand('utaGrammarLab.inferFromFile');
          return;
        }
        const sel = ed.selection;
        const selected = sel && !sel.isEmpty ? doc.getText(sel) : '';
        if (!selected) {
          vscode.window.showWarningMessage('Select some non-grammar text or use “Infer Grammar from File…”.');
          return;
        }
        await runAndShowInference(selected, ctx);
        return;
      }

      // Normal path (non-grammar document)
      await runAndShowInference(text, ctx);
      console.log('inferFromActive file:', doc.fileName, 'guard=', isGrammarFileName(doc.fileName), looksLikeGrammarText(text));
    })
  )

  ctx.subscriptions.push(
    vscode.commands.registerCommand('utaGrammarLab.inferFromFile', async () => {
      const pick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Text files': ['txt','md','log','csv','json','js','py','java','c','cpp'], 'All files': ['*'] }
      });
      if (!pick || pick.length === 0) return;

      if (isGrammarFileName(pick[0].fsPath)) {
        vscode.window.showWarningMessage('That file looks like a .gram. Pick a corpus/source file instead.');
        return;
      }
      const corpus = fs.readFileSync(pick[0].fsPath, 'utf8');
      await runAndShowInference(corpus, ctx);
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('utaGrammarLab.diffGrammars', async () => {
      // Try to use two currently-open grammar docs first
      const editors = vscode.window.visibleTextEditors
        .filter(e => e.document.languageId === 'gramdsl');
      let left: vscode.Uri | undefined = editors[0]?.document.uri;
      let right: vscode.Uri | undefined = editors[1]?.document.uri;

      // If we don't have two, ask the user to pick files
      if (!left) {
        const pick = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Grammar files': ['gram','gramdsl'], 'All files': ['*'] }
        });
        if (!pick) return;
        left = pick[0];
      }
      if (!right) {
        const pick = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Grammar files': ['gram','gramdsl'], 'All files': ['*'] }
        });
        if (!pick) return;
        right = pick[0];
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        'Grammar A ↔ Grammar B'
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('utaGrammarLab.checkCoverage', async () => {
      // 1) Get a grammar document
      let gramDoc = vscode.window.visibleTextEditors.find(e => e.document.languageId === 'gramdsl')?.document;
      if (!gramDoc) {
        const pick = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Grammar files': ['gram','gramdsl'], 'All files': ['*'] }
        });
        if (!pick) return;
        gramDoc = await vscode.workspace.openTextDocument(pick[0]);
      }
      const grammarText = gramDoc.getText();

      // 2) Ask for a source file to check
      const pickSrc = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Source/Text files': ['txt','md','log','csv','json','js','py','java','c','cpp'], 'All files': ['*'] }
      });
      if (!pickSrc) return;

      const srcDoc = await vscode.workspace.openTextDocument(pickSrc[0]);
      const srcEd = await vscode.window.showTextDocument(srcDoc, vscode.ViewColumn.One, false);

      // 3) Extract allowable terminals from grammar
      const allowed = extractQuotedTerminalsFromGrammar(grammarText);

      // 4) Scan each line; mark lines with unknown tokens
      const uncovered: vscode.DecorationOptions[] = [];
      let coveredLines = 0;
      let totalLines = srcDoc.lineCount;

      for (let i = 0; i < totalLines; i++) {
        const line = srcDoc.lineAt(i).text;
        let ok = true;
        const tokens = line.match(TOKENS_RE) || [];

        for (const t of tokens) {
          // allow IDs/NUM/STR; otherwise, token must be in the grammar terminals
          if (
            IDENT_RE.test(t) ||
            NUM_RE.test(t)   ||
            STR_RE.test(t)   ||
            allowed.has(t)
          ) {
            // covered
          } else {
            ok = false;
            break;
          }
        }

        if (!ok && line.trim().length) {
          uncovered.push({
            range: new vscode.Range(i, 0, i, line.length),
            hoverMessage: 'Token(s) on this line are not covered by the inferred grammar.',
          });
        } else {
          coveredLines++;
        }
      }

      srcEd.setDecorations(UNCOVERED_DECOR, uncovered);

      const coveragePct = totalLines === 0 ? 100 : Math.round((coveredLines - uncovered.length) / totalLines * 100);
      vscode.window.setStatusBarMessage(
        `Grammar coverage: ${coveragePct}% • uncovered lines: ${uncovered.length}/${totalLines}`,
        5000
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('utaGrammarLab.fuzzGrammar', async () => {
      // Step 1: pick an active grammar doc
      const grammarDoc =
        vscode.window.visibleTextEditors.find(e => e.document.languageId === 'gramdsl')?.document;
      if (!grammarDoc) {
        vscode.window.showWarningMessage('Open a .gram or .gramdsl file first.');
        return;
      }
      const grammarText = grammarDoc.getText();

      // Step 2: generate N samples
      const samples: string[] = [];
      const N = 10; // number of programs to generate
      for (let i = 0; i < N; i++) {
        samples.push(generateFromGrammar(grammarText, "start", 5));
      }

      // Step 3: open a new editor to show the results
      const content = `// Generated examples (${N})\n\n` + samples.join('\n');
      const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

      vscode.window.setStatusBarMessage(`Generated ${N} samples from inferred grammar`, 5000);
    })
  );
}

export function deactivate() {
  if (currentProc) currentProc.kill();
  return client?.stop();
}

async function openVisualizer(ctx: vscode.ExtensionContext) {
  vizPanel?.dispose();
  const panel = vscode.window.createWebviewPanel(
    'gramViz',
    'Grammar Visualizer',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'media'))],
      retainContextWhenHidden: true,
    }
  );

  vizPanel = panel;
  panel.onDidDispose(() => {changeSub.dispose(); vizPanel = undefined});


  // Load the webview HTML
  const htmlFsUri = vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'visualizer.html'));
  const html = await vscode.workspace.fs.readFile(htmlFsUri);
  panel.webview.html = Buffer.from(html).toString('utf8');
  
  if (lastMetrics) {
    panel.webview.postMessage({ type: 'METRICS', data: lastMetrics });
  }

  // ----- send initial text (declare ONLY ONCE) -----
  const initialDoc = vscode.window.activeTextEditor?.document;
  if (initialDoc && initialDoc.languageId === 'gramdsl') {
    panel.webview.postMessage({
      type: 'GRAMMAR_TEXT',
      text: initialDoc.getText(),
      status: 'Loaded from active editor',
    });
  }

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(async (msg: any) => {
    try {
      switch (msg.type) {
        case 'EXPORT_SVG': {
          if (typeof msg.xml !== 'string') return;
          const uri = await vscode.window.showSaveDialog({
            filters: { SVG: ['svg'] },
            defaultUri: vscode.Uri.file(msg.filename || 'export.svg'),
          });
          if (!uri) return;
          await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.xml, 'utf8'));
          vscode.window.showInformationMessage(`Saved ${uri.fsPath}`);
          break;
        }

        case 'REFRESH': {
          const text = vscode.window.activeTextEditor?.document.getText() ?? '';
          panel.webview.postMessage({ type: 'GRAMMAR_TEXT', text, status: 'Refreshed' });
          break;
        }

        // OPTIONAL: handle extra posts your webview might send
        case 'STATUS':   // vscode.postMessage({type:'STATUS', text:'...'})
        case 'READY':    // sent once when webview loads
        case 'TOKENS':   // if you added lexer debug output
        case 'METRICS':  // if backend metrics posted
          console.log('[webview]', msg.type, msg);
          break;

        default:
          console.warn('[webview] unknown message:', msg);
          // DO NOT throw here
      }
    } catch (e: any) {
      console.error('webview handler error:', e?.message || e);
    }
  });

  // Auto-update when the active .gram changes
  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (
      panel.visible &&
      e.document.languageId === 'gramdsl' &&
      vscode.window.activeTextEditor?.document === e.document
    ) {
      panel.webview.postMessage({
        type: 'GRAMMAR_TEXT',
        text: e.document.getText(),
        status: 'Updated',
      });
    }
  });

  if(!lastPreviewMetrics){
    panel.webview.postMessage({type: 'METRICS', data: lastPreviewMetrics})
  }
}

function schedulePreview(ctx: vscode.ExtensionContext) {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => runInference(ctx, true), 1500);
}

async function runInference(ctx: vscode.ExtensionContext, isPreview: boolean) {
  const cfg = vscode.workspace.getConfiguration('utaGrammarLab');
  const pythonPath = cfg.get<string>('pythonPath') || 'python';
  let inferScript = cfg.get<string>('inferScript') || '';
  if (inferScript.includes('${extensionPath}')) {
    inferScript = inferScript.replace('${extensionPath}', ctx.extensionPath);
  }
  const tracesRel = cfg.get<string>('tracesDir') || 'examples';
  const sample = cfg.get<number>('previewSample') || 300;
  const budget = cfg.get<number>('previewBudgetSeconds') || 0.5;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  if (currentProc) { currentProc.kill(); currentProc = undefined; }

  const args = [inferScript, "--dir", path.join(folder.uri.fsPath, tracesRel)];
  if (isPreview) {
    args.push("--sample", String(sample), "--time_budget", String(budget), "--json");
  } else {
    args.push("--sample", "1000000000", "--time_budget", "3600", "--json");
  }

  const started = Date.now();
  currentProc = spawn(pythonPath, args, { cwd: folder.uri.fsPath });

  const cp = currentProc;

  let buf = '';
  let err = '';

  cp.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
  cp.stderr?.on('data', (d: Buffer) => (err += d.toString()));

  cp.on('close', async (code: number | null) => {
    currentProc = undefined;
    if (code !== 0) {
      console.error('inference non-zero exit', { code, err });
      vscode.window.showErrorMessage(`Inference failed (exit ${code}): ${err || 'unknown error'}`);
      return;
    }
    try {
      const out = JSON.parse(buf);
      const ms = Date.now() - started;

      if (vizPanel) {
        vizPanel.webview.postMessage({ type: 'METRICS', data: out.metrics ?? {} });
        vizPanel.webview.postMessage({ type: 'GRAMMAR_TEXT', text: String(out.grammar || ''), status: isPreview ? 'Preview' : 'Full' });
      }

      if (
        isPreview &&
        lastPreviewMetrics &&
        typeof out.metrics?.mdl === 'number' &&
        typeof lastPreviewMetrics.mdl === 'number' &&
        out.metrics.mdl > lastPreviewMetrics.mdl
      ) {
        vscode.window.setStatusBarMessage(
          `Preview kept (worse MDL: ${out.metrics.mdl.toFixed(2)} > ${lastPreviewMetrics.mdl.toFixed(2)})`,
          3000
        );
        return;
      }

      lastPreviewMetrics = out.metrics;

      const doc = await vscode.workspace.openTextDocument({
        content: out.grammar,
        language: 'gramdsl',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
      vscode.window.setStatusBarMessage(
        `${isPreview ? 'Preview' : 'Full'} inference ✓ in ${ms} ms (coverage=${(out.metrics?.coverage ?? 0).toFixed(
          2
        )}, conflicts=${out.metrics?.conflicts ?? '?'})`,
        5000
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Bad inference JSON: ${e.message}`);
    }
  });
}
