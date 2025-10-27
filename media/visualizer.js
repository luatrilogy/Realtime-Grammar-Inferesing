// visualizer.js
const vscode = acquireVsCodeApi();

const $ = (id) => document.getElementById(id);

$('export').addEventListener('click', () => {
  const svg = $('viz');
  const xml = new XMLSerializer().serializeToString(svg);
  vscode.postMessage({ type: 'EXPORT_SVG', xml, filename: 'grammar-graph.svg' });
});

$('refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'REFRESH' });
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'GRAMMAR_TEXT') {
    $('status').textContent = msg.status || '';
    const model = parseGrammar(msg.text || '');
    const { nullable, first, follow } = firstFollow(model);
    renderTable('first', first);
    renderTable('follow', follow);
    renderGraph(model);
  }
});

/* -------------------- parsing -------------------- */

function parseGrammar(text) {
  // lines like:
  // start: S;
  // A -> B c | d
  const lines = text.split(/\r?\n/);
  const prods = []; // {lhs, rhs: string[]}
  let start = null;
  const nonterminals = new Set();
  const terminals = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('//') || raw.startsWith('#')) continue;

    const s = raw.match(/^start\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*;?/);
    if (s) { start = s[1]; continue; }

    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|→)\s*(.+)$/);
    if (m) {
      const lhs = m[1];
      nonterminals.add(lhs);
      const alts = m[2].split('|');
      for (const alt of alts) {
        const tokens = tokenize(alt.trim());
        prods.push({ lhs, rhs: tokens });
      }
      continue;
    }
  }
  // collect terminals (tokens not starting with capital letter and not ε)
  for (const p of prods) {
    for (const t of p.rhs) {
      if (isNonterminal(t)) nonterminals.add(t);
      else if (t !== 'ε' && t.toLowerCase() !== 'epsilon') terminals.add(t);
    }
  }
  return {
    start: start || (nonterminals.size ? [...nonterminals][0] : null),
    prods,
    nonterminals: [...nonterminals],
    terminals: [...terminals]
  };
}

function tokenize(s) {
  if (!s) return [];
  return s.split(/\s+/).filter(Boolean);
}
function isNonterminal(tok) {
  return /^[A-Z]/.test(tok);
}

/* -------------------- FIRST/FOLLOW -------------------- */

function firstFollow(g) {
  const NT = g.nonterminals;
  const T  = g.terminals;
  const nullable = new Set();
  const FIRST = new Map(); // NT -> Set(token|ε)
  const FOLLOW = new Map(); // NT -> Set(token|$)
  for (const A of NT) { FIRST.set(A, new Set()); FOLLOW.set(A, new Set()); }
  if (g.start) FOLLOW.get(g.start).add('$');

  // helper: FIRST of string α (array of symbols)
  const FIRST_alpha = (alpha) => {
    const out = new Set();
    let allNullable = true;
    for (const X of alpha) {
      if (!isNonterminal(X)) { out.add(X); allNullable = false; break; }
      const fX = FIRST.get(X);
      for (const t of fX) if (t !== 'ε') out.add(t);
      if (!fX.has('ε')) { allNullable = false; break; }
    }
    if (allNullable) out.add('ε');
    return out;
  };

  // iterate to fixed point
  let changed = true;
  while (changed) {
    changed = false;

    // 1) nullable
    for (const p of g.prods) {
      if (p.rhs.length === 0 || p.rhs[0] === 'ε' || p.rhs.every(s => isNonterminal(s) && nullable.has(s))) {
        if (!nullable.has(p.lhs)) { nullable.add(p.lhs); changed = true; }
      }
    }

    // 2) FIRST
    for (const p of g.prods) {
      const A = p.lhs;
      const fA = FIRST.get(A);
      const f = FIRST_alpha(p.rhs);
      for (const t of f) if (!fA.has(t)) { fA.add(t); changed = true; }
    }

    // 3) FOLLOW
    for (const p of g.prods) {
      for (let i = 0; i < p.rhs.length; i++) {
        const B = p.rhs[i];
        if (!isNonterminal(B)) continue;
        const beta = p.rhs.slice(i + 1);
        const fBeta = FIRST_alpha(beta);
        const followB = FOLLOW.get(B);
        let localChanged = false;
        for (const t of fBeta) {
          if (t !== 'ε' && !followB.has(t)) { followB.add(t); localChanged = true; }
        }
        if (beta.length === 0 || fBeta.has('ε')) {
          const followA = FOLLOW.get(p.lhs);
          for (const t of followA) if (!followB.has(t)) { followB.add(t); localChanged = true; }
        }
        if (localChanged) changed = true;
      }
    }
  }
  return { nullable, first: FIRST, follow: FOLLOW };
}

/* -------------------- rendering -------------------- */

function renderTable(targetId, map) {
  const container = $(targetId);
  const rows = [];
  const keys = [...map.keys()].sort();
  rows.push(`<table><thead><tr><th>Nonterminal</th><th>${targetId.toUpperCase()}</th></tr></thead><tbody>`);
  for (const A of keys) {
    const set = [...map.get(A)];
    set.sort((a,b) => (a === 'ε' ? -1 : b === 'ε' ? 1 : a.localeCompare(b)));
    const pills = set.map(s => `<span class="pill">${escapeHtml(s)}</span>`).join(' ');
    rows.push(`<tr><td><code>${escapeHtml(A)}</code></td><td>${pills || '<span class="pill">∅</span>'}</td></tr>`);
  }
  rows.push(`</tbody></table>`);
  container.innerHTML = rows.join('\n');
}

function renderGraph(g) {
  const svg = $('viz');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const ns = g.nonterminals.slice().sort();
  if (ns.length === 0) {
    const t = el('text', { x: 16, y: 36, fill: '#bbb' }, 'No nonterminals found.');
    svg.appendChild(t);
    return;
  }
  const W = 900, H = 40 + 32 * ns.length;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // rows
  const leftX = 140, rightX = 760;
  ns.forEach((A, i) => {
    const y = 40 + i * 32;
    svg.appendChild(el('text', { x: 20, y, fill: '#ddd' }, A));
    svg.appendChild(el('circle', { cx: leftX, cy: y - 6, r: 5, fill: '#59c' }));
    svg.appendChild(el('circle', { cx: rightX, cy: y - 6, r: 5, fill: '#c95' }));
  });

  // edges A -> B if any production of A contains B
  const rowY = (sym) => 40 + ns.indexOf(sym) * 32 - 6;
  const edges = new Set();
  for (const p of g.prods) {
    for (const s of p.rhs) {
      if (isNonterminal(s)) {
        edges.add(`${p.lhs}=>${s}`);
      }
    }
  }
  for (const e of edges) {
    const [A, B] = e.split('=>');
    const y1 = rowY(A);
    const y2 = rowY(B);
    svg.appendChild(el('line', { x1: 146, y1, x2: 754, y2, stroke: '#6a6', 'stroke-width': 1.5, 'marker-end': 'url(#arrow)' }));
  }
  // arrowhead
  const defs = el('defs', {}, '');
  const marker = el('marker', { id: 'arrow', markerWidth: 8, markerHeight: 6, refX: 8, refY: 3, orient: 'auto' });
  marker.appendChild(el('path', { d: 'M0,0 L8,3 L0,6 z', fill: '#6a6' }));
  defs.appendChild(marker);
  svg.appendChild(defs);
}

function el(name, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  if (text) n.textContent = text;
  return n;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}