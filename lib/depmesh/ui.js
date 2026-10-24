'use strict';

/**
 * Self-contained interactive page builder.
 *
 * The page embeds the analysis model as JSON in a <script type="application/json">
 * block, so no data value can ever be interpreted as JavaScript. All rendering is
 * plain DOM + canvas with no external assets, no CDN and no build step: opening
 * the file from disk works offline.
 */

const CSS = `
:root{
  --bg:#0b0d10; --panel:#12161b; --panel-2:#171c23; --line:#232a33;
  --ink:#e6ebf2; --ink-dim:#9aa7b6; --ink-faint:#6b7787;
  --accent:#5aa9ff; --accent-2:#ffb454; --danger:#ff6b6b; --ok:#4ec9a5;
  --cycle:#c792ea; --impact:#ff9f43;
  --mono:"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
  font:13px/1.5 "Segoe UI",system-ui,-apple-system,"Helvetica Neue",sans-serif}
#app{display:grid;grid-template-columns:280px 1fr 340px;grid-template-rows:auto 1fr;height:100%;overflow:hidden}
header{grid-column:1/-1;display:flex;align-items:center;gap:16px;padding:10px 16px;
  border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.02em}
header .badge{font:11px/1 var(--mono);color:var(--ink-dim);border:1px solid var(--line);
  border-radius:3px;padding:4px 6px}
header .grow{flex:1}
aside{background:var(--panel);border-right:1px solid var(--line);overflow:auto;padding:12px}
aside.right{border-right:none;border-left:1px solid var(--line)}
main{position:relative;overflow:hidden}
canvas{display:block;width:100%;height:100%;cursor:grab}
canvas.dragging{cursor:grabbing}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);
  margin:16px 0 8px;font-weight:600}
h2:first-child{margin-top:0}
input[type=search],input[type=text],select{width:100%;background:var(--panel-2);color:var(--ink);
  border:1px solid var(--line);border-radius:4px;padding:6px 8px;font:12px var(--mono);outline:none}
input:focus,select:focus{border-color:var(--accent)}
button{background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:4px;
  padding:5px 9px;font:12px var(--mono);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.on{background:var(--accent);border-color:var(--accent);color:#07131f;font-weight:600}
.row{display:flex;gap:6px;margin-bottom:6px}
.row>*{flex:1;min-width:0}
.kv{display:flex;justify-content:space-between;gap:8px;padding:3px 0;
  border-bottom:1px dotted rgba(255,255,255,.06);font:12px var(--mono)}
.kv b{font-weight:600;color:var(--ink)}
.kv span{color:var(--ink-dim)}
.note{color:var(--ink-faint);font-size:11px;line-height:1.45;margin:6px 0}
.tag{display:inline-block;font:10px/1 var(--mono);padding:3px 5px;border-radius:3px;
  border:1px solid var(--line);color:var(--ink-dim);margin:0 4px 4px 0}
.tag.cycle{color:var(--cycle);border-color:rgba(199,146,234,.4)}
.tag.impact{color:var(--impact);border-color:rgba(255,159,67,.4)}
.tag.high{color:var(--danger);border-color:rgba(255,107,107,.4)}
.tag.medium{color:var(--accent-2);border-color:rgba(255,180,84,.4)}
.tag.critical{color:#fff;background:var(--danger);border-color:var(--danger)}
.list{max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:4px}
.list div{padding:4px 8px;font:11.5px/1.4 var(--mono);color:var(--ink-dim);
  border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;word-break:break-all}
.list div:hover{background:var(--panel-2);color:var(--ink)}
.list div.sel{background:rgba(90,169,255,.14);color:var(--ink)}
#detail .path{font:11.5px/1.5 var(--mono);color:var(--ink-dim);word-break:break-all;
  padding:3px 0;border-bottom:1px dotted rgba(255,255,255,.05)}
#hint{position:absolute;left:12px;bottom:10px;font:11px var(--mono);color:var(--ink-faint);
  pointer-events:none}
#tip{position:absolute;pointer-events:none;background:#000c;border:1px solid var(--line);
  border-radius:4px;padding:5px 7px;font:11px var(--mono);color:var(--ink);display:none;
  max-width:320px;word-break:break-all}
.legend{display:flex;flex-wrap:wrap;gap:8px;font:11px var(--mono);color:var(--ink-dim)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
.empty{color:var(--ink-faint);font-size:11px;padding:6px 0}
.cov{margin:4px 0 10px;padding-left:16px;color:var(--ink-faint);font:11px/1.5 "Segoe UI",system-ui,sans-serif}
.cov li{margin:2px 0}
`.trim();

const RUNTIME = String.raw`
const DATA = JSON.parse(document.getElementById('depmesh-model').textContent);
const CV = document.getElementById('cv');
const CTX = CV.getContext('2d');
const $ = (s) => document.querySelector(s);

const state = {
  selected: null,
  impact: new Set(),
  query: '',
  filter: 'all',
  scale: 1,
  ox: 0,
  oy: 0,
  alpha: 1,
  sim: null,
};

const nodeIndex = new Map(DATA.nodes.map((n) => [n.id, n]));
const adjOut = new Map(DATA.nodes.map((n) => [n.id, []]));
const adjIn = new Map(DATA.nodes.map((n) => [n.id, []]));
const edgeList = DATA.edges.map((e) => ({ s: e.s, t: e.t, k: e.k, n: e.n }));
for (const e of edgeList) {
  if (!adjOut.has(e.s) || !adjOut.has(e.t)) continue;
  adjOut.get(e.s).push(e.t);
  adjIn.get(e.t).push(e.s);
}

// ---- layout -------------------------------------------------------------
// Deterministic seed so the same model always lays out the same way; that makes
// screenshots comparable between runs.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function initLayout() {
  const n = DATA.nodes.length;
  const radius = Math.max(180, Math.sqrt(n) * 34);
  const pos = new Map();
  DATA.nodes.forEach((node, i) => {
    const a = hash(node.id) * Math.PI * 2;
    const r = radius * (0.35 + 0.65 * hash(node.id + '#r'));
    pos.set(node.id, {
      x: Math.cos(a) * r + (hash(node.id + 'x') - 0.5) * 40,
      y: Math.sin(a) * r + (hash(node.id + 'y') - 0.5) * 40,
      vx: 0, vy: 0,
      r: 3.2 + Math.min(7, Math.sqrt(node.in + node.out) * 1.1),
    });
  });
  return pos;
}

const pos = initLayout();

function simulate(steps) {
  const ids = DATA.nodes.map((n) => n.id);
  const k = 46;
  for (let step = 0; step < steps; step++) {
    // repulsion, sampled (O(n^2) is fine up to a few thousand nodes here)
    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j]);
        let dx = a.x - b.x; let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (hash(ids[i]) - 0.5) * 2; dy = (hash(ids[j]) - 0.5) * 2; d2 = 1; }
        if (d2 > 90000) continue;
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    // springs along real edges only
    for (const e of edgeList) {
      const a = pos.get(e.s); const b = pos.get(e.t);
      if (!a || !b) continue;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - k) / d * 0.06;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    // gravity keeps disconnected islands on screen
    for (const id of ids) {
      const p = pos.get(id);
      p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
      p.vx *= 0.72; p.vy *= 0.72;
      p.x += Math.max(-40, Math.min(40, p.vx));
      p.y += Math.max(-40, Math.min(40, p.vy));
    }
  }
}

// ---- drawing ------------------------------------------------------------
function toScreen(x, y) {
  return [x * state.scale + state.ox + CV.width / 2 / dpr, y * state.scale + state.oy + CV.height / 2 / dpr];
}

let dpr = 1;
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = CV.getBoundingClientRect();
  CV.width = Math.max(1, Math.floor(rect.width * dpr));
  CV.height = Math.max(1, Math.floor(rect.height * dpr));
  CTX.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function visible(node) {
  if (state.filter === 'cycle') return node.inCycle;
  if (state.filter === 'orphan') return node.in === 0;
  if (state.filter === 'leaf') return node.out === 0;
  if (state.filter === 'unresolved') return DATA.coverage.unresolved.nodesWithUnknownImports > 0 && state.unresolvedNodes.has(node.id);
  return true;
}

const q = (state.query || '').toLowerCase();
const matched = new Set(q ? DATA.nodes.filter((n) => n.id.toLowerCase().includes(q)).map((n) => n.id) : []);

function draw() {
  const W = CV.width / dpr; const H = CV.height / dpr;
  CTX.clearRect(0, 0, W, H);
  CTX.save();
  CTX.translate(W / 2, H / 2);
  CTX.scale(state.scale, state.scale);
  CTX.translate(state.ox / state.scale, state.oy / state.scale);

  // A filter narrows the canvas; dimming the survivors because something is
  // selected would make the filter unreadable, so selection-dimming only
  // applies in the unfiltered view.
  const dimAll = state.filter === 'all' && (state.impact.size > 0 || q.length > 0);
  const showEdge = (e) => {
    if (state.filter === 'cycle') return nodeIndex.get(e.s)?.inCycle && nodeIndex.get(e.t)?.inCycle;
    return true;
  };

  CTX.lineWidth = 1 / state.scale;
  for (const e of edgeList) {
    if (!showEdge(e)) continue;
    const a = pos.get(e.s); const b = pos.get(e.t);
    if (!a || !b) continue;
    const hot = state.selected && (e.s === state.selected || e.t === state.selected);
    const inImpact = state.impact.has(e.s) && state.impact.has(e.t);
    CTX.strokeStyle = hot ? 'rgba(90,169,255,.85)'
      : inImpact ? 'rgba(255,159,67,.55)'
      : dimAll ? 'rgba(120,135,155,.06)'
      : 'rgba(120,135,155,.20)';
    CTX.beginPath();
    CTX.moveTo(a.x, a.y);
    CTX.lineTo(b.x, b.y);
    CTX.stroke();
    if (hot) {
      const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      CTX.save();
      CTX.translate(mx, my);
      CTX.rotate(ang);
      CTX.fillStyle = 'rgba(90,169,255,.9)';
      CTX.beginPath();
      CTX.moveTo(0, 0); CTX.lineTo(-5, 2.6); CTX.lineTo(-5, -2.6);
      CTX.closePath();
      CTX.fill();
      CTX.restore();
    }
  }

  for (const node of DATA.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    if (!visible(node)) continue;
    const isSel = state.selected === node.id;
    const isImpact = state.impact.has(node.id);
    const isMatch = matched.has(node.id);
    // A filter is a question about one category, so its colour must win over the
    // blast-radius tint; otherwise picking "cycles" after selecting a node paints
    // the whole graph orange and the filter looks broken.
    const filterWins = state.filter !== 'all';
    let fill = node.inCycle ? '#c792ea' : '#5f7183';
    if (node.out === 0 && !node.inCycle) fill = '#4ec9a5';
    if (isImpact && !filterWins) fill = '#ff9f43';
    if (isSel) fill = '#5aa9ff';
    if (isMatch) fill = '#ffd166';
    if (filterWins && !isSel && !isMatch) fill = node.inCycle ? '#c792ea' : fill;
    CTX.globalAlpha = dimAll && !isImpact && !isSel && !isMatch && !filterWins ? 0.28 : 1;
    CTX.fillStyle = fill;
    CTX.beginPath();
    CTX.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    CTX.fill();
    if (isSel || isMatch) {
      CTX.strokeStyle = '#fff';
      CTX.lineWidth = 1.6 / state.scale;
      CTX.beginPath();
      CTX.arc(p.x, p.y, p.r + 3 / state.scale, 0, Math.PI * 2);
      CTX.stroke();
    }
    CTX.globalAlpha = 1;
  }

  // labels only where they stay legible
  const labelBudget = state.scale > 0.55 ? 220 : 0;
  let drawn = 0;
  CTX.font = (11 / state.scale) + 'px "Cascadia Mono",Consolas,monospace';
  CTX.textAlign = 'center';
  for (const node of DATA.nodes) {
    if (drawn > labelBudget) break;
    const p = pos.get(node.id);
    if (!p || !visible(node)) continue;
    const important = state.selected === node.id || state.impact.has(node.id) || matched.has(node.id);
    if (!important && node.in + node.out < 6) continue;
    CTX.fillStyle = important ? 'rgba(230,235,242,.95)' : 'rgba(154,167,182,.65)';
    CTX.fillText(node.id.split('/').pop(), p.x, p.y - p.r - 4 / state.scale);
    drawn++;
  }
  CTX.restore();
}

// ---- interaction --------------------------------------------------------
let dragging = null;
let panning = null;

function pick(mx, my) {
  let best = null; let bestD = 16 / state.scale;
  for (const node of DATA.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const sx = (p.x * state.scale + state.ox) + CV.width / dpr / 2;
    const sy = (p.y * state.scale + state.oy) + CV.height / dpr / 2;
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bestD) { bestD = d; best = node; }
  }
  return best;
}

CV.addEventListener('mousedown', (ev) => {
  const rect = CV.getBoundingClientRect();
  const mx = ev.clientX - rect.left; const my = ev.clientY - rect.top;
  const hit = pick(mx, my);
  if (hit) { dragging = hit.id; select(hit.id); }
  else { panning = { x: mx - state.ox, y: my - state.oy }; CV.classList.add('dragging'); }
});

window.addEventListener('mousemove', (ev) => {
  const rect = CV.getBoundingClientRect();
  const mx = ev.clientX - rect.left; const my = ev.clientY - rect.top;
  if (dragging) {
    const p = pos.get(dragging);
    p.x = (mx - state.ox - CV.width / dpr / 2) / state.scale;
    p.y = (my - state.oy - CV.height / dpr / 2) / state.scale;
    draw();
    return;
  }
  if (panning) {
    state.ox = mx - panning.x; state.oy = my - panning.y;
    draw();
    return;
  }
  const hit = pick(mx, my);
  const tip = $('#tip');
  if (hit) {
    tip.style.display = 'block';
    tip.style.left = (mx + 14) + 'px';
    tip.style.top = (my + 14) + 'px';
    tip.textContent = hit.id + '  [in ' + hit.in + ' / out ' + hit.out + ']';
  } else {
    tip.style.display = 'none';
  }
});

window.addEventListener('mouseup', () => {
  dragging = null; panning = null; CV.classList.remove('dragging');
});

CV.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = CV.getBoundingClientRect();
  const mx = ev.clientX - rect.left - CV.width / dpr / 2;
  const my = ev.clientY - rect.top - CV.height / dpr / 2;
  const factor = Math.exp(-ev.deltaY * 0.0015);
  const next = Math.max(0.12, Math.min(6, state.scale * factor));
  state.ox = mx - (mx - state.ox) * (next / state.scale);
  state.oy = my - (my - state.oy) * (next / state.scale);
  state.scale = next;
  draw();
}, { passive: false });

// ---- panels -------------------------------------------------------------
function closure(start, adj) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift();
    for (const m of adj.get(n) || []) {
      if (dist.has(m)) continue;
      dist.set(m, dist.get(n) + 1);
      queue.push(m);
    }
  }
  dist.delete(start);
  return dist;
}

function select(id) {
  state.selected = id;
  state.impact = new Set(closure(id, adjIn).keys());
  renderDetail();
  draw();
  renderLists();
}

function renderDetail() {
  const el = $('#detail');
  if (!state.selected) {
    el.innerHTML = '<p class="note">Click a node to inspect its direct dependents, dependencies and blast radius.</p>';
    return;
  }
  const node = nodeIndex.get(state.selected);
  const out = (adjOut.get(state.selected) || []).slice().sort();
  const inn = (adjIn.get(state.selected) || []).slice().sort();
  const impact = closure(state.selected, adjIn);
  const comp = DATA.cycles.components.find((c) => c.nodes.includes(state.selected));
  const parts = [];
  parts.push('<div class="kv"><span>module</span><b>' + esc(node.id) + '</b></div>');
  parts.push('<div class="kv"><span>imports</span><b>' + out.length + '</b></div>');
  parts.push('<div class="kv"><span>imported by</span><b>' + inn.length + '</b></div>');
  parts.push('<div class="kv"><span>blast radius</span><b>' + impact.size + '</b></div>');
  parts.push('<div class="kv"><span>size</span><b>' + node.bytes + ' B</b></div>');
  if (comp) parts.push('<div class="kv"><span>cycle</span><b>component #' + comp.index + ' (' + comp.size + ')</b></div>');
  parts.push('<h2>Imports</h2>');
  parts.push(out.length ? '<div class="list">' + out.map((id2) => '<div data-go="' + esc(id2) + '">' + esc(id2) + '</div>').join('') + '</div>' : '<p class="empty">none</p>');
  parts.push('<h2>Imported by</h2>');
  parts.push(inn.length ? '<div class="list">' + inn.map((id2) => '<div data-go="' + esc(id2) + '">' + esc(id2) + '</div>').join('') + '</div>' : '<p class="empty">none</p>');
  parts.push('<h2>Blast radius (transitive dependents)</h2>');
  if (impact.size) {
    const byDepth = {};
    for (const [k, d] of impact) (byDepth[d] = byDepth[d] || []).push(k);
    for (const d of Object.keys(byDepth).sort((a, b) => a - b)) {
      parts.push('<div class="kv"><span>' + d + ' hop(s)</span><b>' + byDepth[d].length + '</b></div>');
    }
    const sample = [...impact.keys()].sort().slice(0, 60);
    parts.push('<div class="list">' + sample.map((id2) => '<div data-go="' + esc(id2) + '">' + esc(id2) + '</div>').join('') + '</div>');
  } else parts.push('<p class="empty">nothing imports this module</p>');
  el.innerHTML = parts.join('');
  el.querySelectorAll('[data-go]').forEach((div) => div.addEventListener('click', () => select(div.dataset.go)));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLists() {
  const cy = $('#cycleList');
  if (!DATA.cycles.components.length) {
    cy.innerHTML = '<p class="empty">No cyclic components. The graph is a DAG.</p>';
  } else {
    cy.innerHTML = DATA.cycles.components.map((c) =>
      '<div class="list" style="margin-bottom:8px"><div style="cursor:default;color:var(--cycle)">#' + c.index + ' - ' + c.size + ' modules, ' + c.internalEdges + ' internal edges</div>' +
      c.samples.map((s) => '<div data-go="' + esc(s[0]) + '">' + esc(s.join(' > ')) + '</div>').join('') + '</div>').join('');
    cy.querySelectorAll('[data-go]').forEach((d) => d.addEventListener('click', () => select(d.dataset.go)));
  }

  const un = $('#unresolvedList');
  const findings = DATA.coverage.unresolved.findings;
  if (!findings.length) {
    un.innerHTML = '<p class="empty">Every internal import resolved.</p>';
  } else {
    un.innerHTML = findings.map((f) =>
      '<div class="tag ' + f.severity + '">' + f.severity + '</div> <span class="tag">' + f.reason + '</span> <b>' + f.count + '</b>' +
      '<div class="list" style="margin:4px 0 8px">' +
      f.examples.map((e2) => '<div>' + esc(e2.file) + ' &rarr; ' + esc(e2.specifier || '(parse error)') + '</div>').join('') +
      '</div>').join('');
  }
}

function renderStats() {
  const s = DATA.stats;
  const c = DATA.coverage;
  const rows = [
    ['modules', s.nodes], ['import edges', s.edges],
    ['density', s.density], ['entry points', s.roots], ['leaves', s.leaves],
    ['cyclic components', s.cycleComponents], ['modules in cycles', s.cyclicNodes],
    ['external packages', s.externals], ['unresolved imports', s.unresolved],
    ['specifiers seen', c.specifiers.total], ['resolved internal', c.specifiers.resolvedInternal],
    ['internal rate', (c.specifiers.internalRatio * 100).toFixed(2) + '%'],
  ];
  $('#stats').innerHTML = rows.map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('');
}

// What the graph does NOT contain is part of the answer, so it is rendered as
// a first-class panel rather than buried in a collapsed block.
function renderCoverage() {
  const c = DATA.coverage;
  const el = $('#coverage');
  const row = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';
  const parts = [];
  parts.push(row('files parsed', c.files.parsed + ' / ' + c.files.nodes));
  parts.push(row('files unparsed', c.files.unparsed));
  parts.push(row('specifiers', c.specifiers.total));
  parts.push(row('resolved internal', c.specifiers.resolvedInternal));
  parts.push(row('resolved external', c.specifiers.resolvedExternal));
  parts.push(row('unresolved', c.specifiers.failed));
  parts.push(row('edges type-only', c.edges.typeOnly));

  const forms = Object.entries(c.specifiers.byForm || {});
  if (forms.length) {
    parts.push('<div style="margin:6px 0">' +
      forms.map(([k, v]) => '<span class="tag">' + esc(k) + ' ' + v + '</span>').join('') + '</div>');
  }

  parts.push('<p class="note"><b>Guaranteed</b></p><ul class="cov">' +
    c.guarantees.map((g) => '<li>' + esc(g) + '</li>').join('') + '</ul>');
  parts.push('<p class="note"><b>Not covered</b></p><ul class="cov">' +
    c.caveats.map((g) => '<li>' + esc(g) + '</li>').join('') + '</ul>');
  el.innerHTML = parts.join('');
}

// ---- path finder --------------------------------------------------------
function findPaths() {
  const from = $('#pathFrom').value.trim();
  const to = $('#pathTo').value.trim();
  const out = $('#pathResult');
  if (!nodeIndex.has(from) || !nodeIndex.has(to)) { out.innerHTML = '<p class="empty">unknown module id</p>'; return; }
  const maxLength = Number($('#pathLen').value) || 12;
  const found = [];
  const stack = [[from, [from], new Set([from])]];
  let expansions = 0; let truncated = false;
  while (stack.length) {
    if (found.length >= 25) { truncated = true; break; }
    const [n, chain, seen] = stack.pop();
    if (chain.length - 1 >= maxLength) continue;
    for (const m of adjOut.get(n) || []) {
      if (++expansions > 120000) { truncated = true; break; }
      if (m === to) { found.push([...chain, m]); continue; }
      if (seen.has(m)) continue;
      const nextSeen = new Set(seen); nextSeen.add(m);
      stack.push([m, [...chain, m], nextSeen]);
    }
    if (truncated) break;
  }
  found.sort((a, b) => a.length - b.length);
  out.innerHTML = found.length
    ? found.map((p) => '<div class="path">' + esc(p.join(' > ')) + '</div>').join('') +
      (truncated ? '<p class="note">truncated by budget - more paths exist</p>' : '')
    : '<p class="empty">no path within ' + maxLength + ' hops</p>';
}

// ---- wiring -------------------------------------------------------------
$('#search').addEventListener('input', (ev) => {
  state.query = ev.target.value.trim();
  matched.clear();
  const qq = state.query.toLowerCase();
  if (qq) DATA.nodes.filter((n) => n.id.toLowerCase().includes(qq)).forEach((n) => matched.add(n.id));
  draw();
});

document.querySelectorAll('[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    state.filter = btn.dataset.filter;
    draw();
  });
});

$('#clear').addEventListener('click', () => {
  state.selected = null; state.impact = new Set(); state.query = '';
  $('#search').value = '';
  matched.clear();
  renderDetail(); draw();
});

$('#fit').addEventListener('click', () => {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const W = CV.width / dpr; const H = CV.height / dpr;
  const sx = (W - 80) / Math.max(1, maxX - minX);
  const sy = (H - 80) / Math.max(1, maxY - minY);
  state.scale = Math.max(0.12, Math.min(2.4, Math.min(sx, sy)));
  state.ox = -((minX + maxX) / 2) * state.scale;
  state.oy = -((minY + maxY) / 2) * state.scale;
  draw();
});

$('#pathGo').addEventListener('click', findPaths);

window.addEventListener('resize', resize);

// unresolved node set used by the filter
state.unresolvedNodes = new Set();
for (const f of DATA.coverage.unresolved.findings) for (const e of f.examples) state.unresolvedNodes.add(e.file);

simulate(220);
renderStats();
renderCoverage();
renderLists();
renderDetail();
resize();
$('#fit').click();
`.trim();

function buildPage(model) {
	const payload = JSON.stringify(model).replace(/</g, '\\u003c');
	const meta = model.meta;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>depmesh - ${escapeHtml(meta.baseDir)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230b0d10'/%3E%3Cg stroke='%235aa9ff' stroke-width='1.6'%3E%3Cpath d='M9 9 L16 16 L9 23 M16 16 L23 9 M16 16 L23 23'/%3E%3C/g%3E%3Cg fill='%23e6ebf2'%3E%3Ccircle cx='9' cy='9' r='2.4'/%3E%3Ccircle cx='9' cy='23' r='2.4'/%3E%3Ccircle cx='16' cy='16' r='2.8'/%3E%3Ccircle cx='23' cy='9' r='2.4'/%3E%3Ccircle cx='23' cy='23' r='2.4'/%3E%3C/g%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <header>
    <h1>depmesh</h1>
    <span class="badge">${escapeHtml(meta.baseDir)}</span>
    <span class="badge">${model.stats.nodes} modules / ${model.stats.edges} edges</span>
    <span class="badge">${model.stats.cycleComponents} cyclic components</span>
    <span class="badge">${model.coverage.specifiers.failed} unresolved</span>
    <span class="grow"></span>
    <span class="badge">generated ${escapeHtml(meta.generatedAt)}</span>
  </header>

  <aside>
    <h2>Search</h2>
    <input id="search" type="search" placeholder="module id substring">
    <div class="row" style="margin-top:6px">
      <button id="fit">Fit</button>
      <button id="clear">Clear</button>
    </div>

    <h2>Filter</h2>
    <div class="row">
      <button data-filter="all" class="on">All</button>
      <button data-filter="cycle">Cycles</button>
    </div>
    <div class="row">
      <button data-filter="orphan">Entries</button>
      <button data-filter="leaf">Leaves</button>
    </div>

    <h2>Legend</h2>
    <div class="legend">
      <span><i style="background:#5f7183"></i>module</span>
      <span><i style="background:#c792ea"></i>in a cycle</span>
      <span><i style="background:#4ec9a5"></i>leaf</span>
      <span><i style="background:#ff9f43"></i>blast radius</span>
      <span><i style="background:#5aa9ff"></i>selected</span>
    </div>

    <h2>Cyclic components</h2>
    <div id="cycleList"></div>

    <h2>Unresolved imports</h2>
    <div id="unresolvedList"></div>
  </aside>

  <main>
    <canvas id="cv"></canvas>
    <div id="hint">drag node to pin &middot; drag background to pan &middot; wheel to zoom</div>
    <div id="tip"></div>
  </main>

  <aside class="right">
    <h2>Graph totals</h2>
    <div id="stats"></div>

    <h2>Dependency path finder</h2>
    <div class="row"><input id="pathFrom" type="text" placeholder="from module id"></div>
    <div class="row"><input id="pathTo" type="text" placeholder="to module id"></div>
    <div class="row">
      <input id="pathLen" type="text" value="12" title="max hops">
      <button id="pathGo">Find paths</button>
    </div>
    <div id="pathResult"></div>

    <h2>Selected module</h2>
    <div id="detail"></div>

    <h2>Coverage ledger</h2>
    <div id="coverage"></div>
  </aside>
</div>

<script type="application/json" id="depmesh-model">${payload}</script>
<script>${RUNTIME}</script>
</body>
</html>
`;
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'
	}[c]));
}

module.exports = {buildPage, CSS, RUNTIME};
