// Compare two texts (v12). Runs only in this browser. It never changes the OCR text: it only shows differences.
const $ = s => document.querySelector(s);
const MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;          // nikud + te'amim (keeps maqaf, sof pasuq)
const INVIS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;     // zero-width and direction marks
const DASH = /[\u05BE\u2010-\u2015\-]/g;                                     // maqaf and dashes
const PUNCT = /[\p{P}\p{S}\u05C0\u05C3\u05C6\u05F3\u05F4]/gu;
const LABEL_LINE = /^\s*(\[\[[^\]\n]*\]\]|===.*===)\s*$/gm;

export function norm(s, o) {
  s = s.normalize('NFC').replace(INVIS, '');
  if (o.nikud) s = s.replace(MARKS, '');
  if (o.punct) s = s.replace(PUNCT, '');
  return s;
}
// Split into word tokens. Each token keeps its original spelling (shown) and its normalized form (compared).
export function tokenize(text, o) {
  let t = text.replace(/\r\n?/g, '\n');
  if (o.labels) t = t.replace(LABEL_LINE, '');
  if (o.punct) t = t.replace(DASH, ' ');
  const out = []; let pend = '';
  const re = o.spacing ? /\S+/g : /\n|[^\s]+/g;
  let m;
  while ((m = re.exec(t))) {
    const w = m[0];
    if (w === '\n') { // line break as its own token (only when spacing/line breaks count)
      if (out.length && out[out.length - 1].n === '\u21B5') continue;
      out.push({ s: '\u21B5', n: '\u21B5', br: true, i: m.index }); continue; }
    const n = norm(w, o);
    if (!n) { if (out.length && !out[out.length - 1].br) out[out.length - 1].s += ' ' + w; else pend += w + ' '; continue; }
    out.push({ s: pend + w, n, v: o.nikud ? (pend + w).normalize('NFC').replace(INVIS, '').replace(MARKS, '') : pend + w, i: m.index }); pend = '';
  }
  while (out.length && out[0].br) out.shift();
  while (out.length && out[out.length - 1].br) out.pop();
  return out;
}

// ---------- word diff: common prefix/suffix, unique-word anchors (patience), then LCS on small pieces ----------
function lcsOps(a, b, a0, a1, b0, b1, ops) {
  const n = a1 - a0, m = b1 - b0;
  if (!n) { for (let j = b0; j < b1; j++) ops.push(['+', -1, j]); return; }
  if (!m) { for (let i = a0; i < a1; i++) ops.push(['-', i, -1]); return; }
  if (n * m > 6e6) { for (let i = a0; i < a1; i++) ops.push(['-', i, -1]); for (let j = b0; j < b1; j++) ops.push(['+', -1, j]); return; }
  const W = m + 1, T = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    T[i * W + j] = a[a0 + i] === b[b0 + j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) { ops.push(['=', a0 + i, b0 + j]); i++; j++; }
    else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) { ops.push(['-', a0 + i, -1]); i++; }
    else { ops.push(['+', -1, b0 + j]); j++; }
  }
  for (; i < n; i++) ops.push(['-', a0 + i, -1]); for (; j < m; j++) ops.push(['+', -1, b0 + j]);
}
function diffRange(a, b, a0, a1, b0, b1, ops, depth) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { ops.push(['=', a0, b0]); a0++; b0++; }
  const tail = [];
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; tail.push(['=', a1, b1]); }
  if ((a1 - a0) * (b1 - b0) <= 250000 || depth > 40) lcsOps(a, b, a0, a1, b0, b1, ops);
  else {
    // anchors: words that occur the same small number of times on both sides (1 first, then up to 2, 4, 8), matched in order
    const oa = new Map(), ob = new Map();
    for (let i = a0; i < a1; i++) { let l = oa.get(a[i]); if (!l) oa.set(a[i], l = []); l.push(i); }
    for (let j = b0; j < b1; j++) { let l = ob.get(b[j]); if (!l) ob.set(b[j], l = []); l.push(j); }
    let anchors = [];
    for (const k of [1, 2, 4, 8]) {
      const pairs = [];
      for (const [wd, lb] of ob) { const la = oa.get(wd); if (la && la.length === lb.length && lb.length <= k) lb.forEach((j, q) => pairs.push([la[q], j])); }
      if (!pairs.length) continue;
      pairs.sort((x, y) => x[1] - y[1]);
      const tails = [], prev = new Array(pairs.length);   // longest increasing subsequence of a-indexes (patience sorting)
      pairs.forEach((p, q) => { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][0] < p[0]) lo = mid + 1; else hi = mid; } prev[q] = lo ? tails[lo - 1] : -1; tails[lo] = q; });
      for (let q = tails[tails.length - 1]; q >= 0; q = prev[q]) anchors.push(pairs[q]); anchors.reverse();
      break;
    }
    if (!anchors.length) lcsOps(a, b, a0, a1, b0, b1, ops);
    else { let pa = a0, pb = b0; for (const [i, j] of anchors) { diffRange(a, b, pa, i, pb, j, ops, depth + 1); ops.push(['=', i, j]); pa = i + 1; pb = j + 1; } diffRange(a, b, pa, a1, pb, b1, ops, depth + 1); }
  }
  for (let k = tail.length - 1; k >= 0; k--) ops.push(tail[k]);
}
function lev(x, y) { // edit distance between two short strings (letters)
  const X = [...x], Y = [...y]; if (!X.length) return Y.length; if (!Y.length) return X.length;
  let p = Array.from({ length: Y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= X.length; i++) { const c = [i]; for (let j = 1; j <= Y.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (X[i - 1] === Y[j - 1] ? 0 : 1)); p = c; }
  return p[Y.length];
}
function charDiff(x, y) { // [[op, text]] at letter level (op: '=', '-', '+')
  const X = [...x], Y = [...y], n = X.length, m = Y.length; if (n * m > 40000) return [['-', x], ['+', y]];
  const W = m + 1, T = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i * W + j] = X[i] === Y[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
  const out = []; const put = (op, ch) => { const l = out[out.length - 1]; if (l && l[0] === op) l[1] += ch; else out.push([op, ch]); };
  let i = 0, j = 0; while (i < n && j < m) { if (X[i] === Y[j]) { put('=', X[i]); i++; j++; } else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) put('-', X[i++]); else put('+', Y[j++]); }
  while (i < n) put('-', X[i++]); while (j < m) put('+', Y[j++]); return out;
}
// Pair the words of one change block: similar words become "changed" pairs, the rest are removed/added.
function alignHunk(d, s) {
  const n = d.length, m = s.length, steps = [];
  if (!n || !m || n * m > 4000) { const k = Math.min(n, m); for (let i = 0; i < Math.max(n, m); i++) steps.push(i < k ? ['~', d[i], s[i]] : i < n ? ['-', d[i]] : ['+', s[i]]); return steps; }
  const sub = (x, y) => { const L = Math.max([...x].length, [...y].length) || 1; const c = lev(x, y) / L; return c <= 0.67 ? c : Infinity; };
  const C = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) {
    if (i === n && j === m) continue;
    let best = Infinity;
    if (i < n) best = Math.min(best, 1 + C[i + 1][j]);
    if (j < m) best = Math.min(best, 1 + C[i][j + 1]);
    if (i < n && j < m) best = Math.min(best, sub(d[i].n, s[j].n) + C[i + 1][j + 1]);
    C[i][j] = best;
  }
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && Math.abs(C[i][j] - (sub(d[i].n, s[j].n) + C[i + 1][j + 1])) < 1e-9) { steps.push(['~', d[i], s[j]]); i++; j++; }
    else if (i < n && Math.abs(C[i][j] - (1 + C[i + 1][j])) < 1e-9) steps.push(['-', d[i++]]);
    else steps.push(['+', s[j++]]);
  }
  return steps;
}
const letters = s => [...s.replace(/\s|\u21B5/g, '')].length;

// Build hunks: runs of equal tokens and change blocks {del:[tokens], ins:[tokens]}.
export function compareTexts(textA, textB, o) {
  const A = tokenize(textA, o), B = tokenize(textB, o);
  const ops = []; diffRange(A.map(t => t.n), B.map(t => t.n), 0, A.length, 0, B.length, ops, 0);
  const items = []; let cur = null;
  for (const [op, i, j] of ops) {
    if (op === '=') { cur = null; items.push({ eq: true, a: A[i], b: B[j] }); continue; }
    if (!cur) { cur = { del: [], ins: [] }; items.push(cur); }
    if (op === '-') cur.del.push(A[i]); else cur.ins.push(B[j]);
  }
  const st = { changed: 0, added: 0, missing: 0, letterErr: 0, lettersB: 0, lettersA: 0, wordsA: A.filter(t => !t.br).length, wordsB: B.filter(t => !t.br).length, spaceOnly: 0, diffs: 0 };
  A.forEach(t => { if (!t.br) st.lettersA += letters(t.n); }); B.forEach(t => { if (!t.br) st.lettersB += letters(t.n); });
  for (const it of items) {
    if (it.eq) continue;
    const d = it.del.filter(t => !t.br), s = it.ins.filter(t => !t.br);
    const dj = d.map(t => t.n).join(''), sj = s.map(t => t.n).join('');
    if (o.spacing && dj === sj) { it.spaceOnly = true; st.spaceOnly++; continue; }   // words only split/joined differently
    if (!d.length && !s.length) { it.breakOnly = true; }
    it.k = st.diffs++;
    it.steps = alignHunk(d, s); const pairs = it.steps.filter(x => x[0] === '~').length;
    st.changed += pairs; st.missing += d.length - pairs; st.added += s.length - pairs;
    st.letterErr += dj.length * sj.length <= 4e6 ? lev(dj, sj)
      : it.steps.reduce((x, p) => x + (p[0] === '~' ? lev(p[1].n, p[2].n) : letters(p[1].n)), 0);
  }
  st.cer = st.lettersB ? st.letterErr / st.lettersB : (st.lettersA ? 1 : 0);
  return { items, stats: st };
}

// ---------- rendering ----------
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function wordPair(a, b) { // a removed word and its replacement, with the changed letters marked darker
  const cd = charDiff(a, b);
  const del = cd.filter(x => x[0] !== '+').map(([op, t]) => op === '-' ? `<b>${esc(t)}</b>` : esc(t)).join('');
  const ins = cd.filter(x => x[0] !== '-').map(([op, t]) => op === '+' ? `<b>${esc(t)}</b>` : esc(t)).join('');
  return `<del>${del}</del><ins>${ins}</ins>`;
}
function hunkHTML(it) {
  const out = [];
  for (const p of it.steps || []) {
    if (p[0] === '~') out.push(wordPair(p[1].v, p[2].v));
    else if (p[0] === '-') { const l = out[out.length - 1]; if (l && l.startsWith('<del class="only">')) out[out.length - 1] = l.replace('</del>', ' ' + esc(p[1].v) + '</del>'); else out.push(`<del class="only">${esc(p[1].v)}</del>`); }
    else { const l = out[out.length - 1]; if (l && l.startsWith('<ins class="only">')) out[out.length - 1] = l.replace('</ins>', ' ' + esc(p[1].v) + '</ins>'); else out.push(`<ins class="only">${esc(p[1].v)}</ins>`); }
  }
  if (it.breakOnly) out.push(it.del.length ? '<del class="br">\u21B5</del>' : '<ins class="br">\u21B5</ins>');
  return out.join(' ');
}
export function renderDiff(res) {
  const parts = [];
  for (const it of res.items) {
    if (it.eq) { parts.push(it.a.br ? '<br>' : (it.a.s !== it.b.s ? `<span class="eqv" title="${esc(it.b.s)}">${esc(it.a.s)}</span>` : esc(it.a.s))); continue; }
    if (it.spaceOnly) { parts.push(`<span class="sp" title="${esc(it.ins.map(t => t.s).join(' '))}">${esc(it.del.map(t => t.s).join(' '))}</span>`); continue; }
    parts.push(`<span class="hunk" id="dif${it.k}" data-k="${it.k}" tabindex="0">${hunkHTML(it)}</span>`);
    const after = it.del.length && it.del[it.del.length - 1].br && it.ins.length && it.ins[it.ins.length - 1].br; if (after) parts.push('<br>');
  }
  return parts.join(' ').replace(/ <br> /g, '<br>');
}
function summaryText(st) {
  const pct = (st.cer * 100).toFixed(st.cer < 0.1 ? 2 : 1);
  return { pct, line: `${pct}% of letters differ (${st.letterErr} of ${st.lettersB} letters in Text B) · ${st.changed} word${st.changed === 1 ? '' : 's'} changed · ${st.added} added in B · ${st.missing} missing from B` };
}
function listRows(res, max) {
  const rows = [];
  for (const it of res.items) {
    if (it.eq || it.spaceOnly) continue; if (rows.length >= max) break;
    const a = it.del.filter(t => !t.br).map(t => t.v).join(' '), b = it.ins.filter(t => !t.br).map(t => t.v).join(' ');
    rows.push({ k: it.k, a: a || (it.breakOnly ? '\u21B5' : '—'), b: b || (it.breakOnly ? '\u21B5' : '—') });
  }
  return rows;
}
function contextOf(res, k, side, w = 4) { // a few words around a difference, from one side
  const idx = res.items.findIndex(it => it.k === k); const pick = it => it.eq ? (side === 'a' ? it.a : it.b) : null;
  const bef = [], aft = [];
  for (let i = idx - 1; i >= 0 && bef.length < w; i--) { const t = pick(res.items[i]); if (t && !t.br) bef.unshift(t.s); else if (!res.items[i].eq) break; }
  for (let i = idx + 1; i < res.items.length && aft.length < w; i++) { const t = pick(res.items[i]); if (t && !t.br) aft.push(t.s); else if (!res.items[i].eq) break; }
  return [bef.join(' '), aft.join(' ')];
}
export function textReport(res, o, names) {
  const s = summaryText(res.stats); const L = [];
  L.push('Hebrew OCR — text comparison', new Date().toLocaleString(), `Text A: ${names.a}`, `Text B: ${names.b}`,
    `Ignored: ${[o.nikud && 'nikud/te\'amim', o.punct && 'punctuation', o.spacing && 'spacing/line breaks', o.labels && 'page/section labels'].filter(Boolean).join(', ') || 'nothing'}`, '', s.line, '');
  listRows(res, 1e9).forEach((r, i) => { const [b, a] = contextOf(res, r.k, 'b'); L.push(`${i + 1}. A: ${r.a}`, `   B: ${r.b}`, `   (in B: …${b} [${r.b}] ${a}…)`, ''); });
  if (!res.stats.diffs) L.push('No differences.');
  return '\ufeff' + L.join('\n') + '\n';
}
export function htmlReport(res, o, names, css) {
  const s = summaryText(res.stats);
  const rows = listRows(res, 1e9).map((r, i) => `<tr><td>${i + 1}</td><td dir="rtl">${esc(r.a)}</td><td dir="rtl">${esc(r.b)}</td></tr>`).join('');
  return `<!doctype html><html lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Text comparison</title><style>${css}
body{font:15px/1.5 system-ui,Arial,sans-serif;max-width:1000px;margin:20px auto;padding:0 14px;color:#1d2433}table{border-collapse:collapse;width:100%;font:18px/1.5 var(--heb)}td,th{border:1px solid #e3e6ec;padding:4px 8px;text-align:right}th{font:600 14px system-ui,sans-serif;background:#f5f3ee}</style></head><body>
<h1 style="font-size:20px">Text comparison</h1><p>Text A: ${esc(names.a)}<br>Text B: ${esc(names.b)}<br>${esc(new Date().toLocaleString())}</p>
<p><b>${esc(s.line)}</b></p><div class="legend"><del>removed (only in A)</del> <ins>added (in B)</ins> <span class="muted">darker letters = the exact letters that differ</span></div>
<div class="cmp-out" dir="rtl" lang="he">${renderDiff(res)}</div><h2 style="font-size:17px">Every difference</h2><table><tr><th>#</th><th>Text A</th><th>Text B</th></tr>${rows || '<tr><td colspan="3">No differences.</td></tr>'}</table></body></html>`;
}

// ---------- UI ----------
const REPORT_CSS = `:root{--heb:"Frank Ruehl","Frank Ruehl CLM","David","Times New Roman","Noto Serif Hebrew","SBL Hebrew",serif}
.cmp-out{font:21px/1.9 var(--heb);direction:rtl;text-align:right;background:#fffef9;border:1px solid #cfd5df;border-radius:10px;padding:14px 16px;white-space:normal;overflow-wrap:anywhere}
.cmp-out del,.legend del{background:#fde2e0;color:#8f1d16;text-decoration:line-through;text-decoration-thickness:1px;border-radius:4px;padding:0 2px}
.cmp-out ins,.legend ins{background:#dcf2e3;color:#145c32;text-decoration:none;border-radius:4px;padding:0 2px}
.cmp-out del b{background:#f5a29a;color:#5c0d08;font-weight:700}.cmp-out ins b{background:#86d3a0;color:#073d1f;font-weight:700}
.cmp-out .hunk{border-radius:6px;cursor:pointer;scroll-margin:120px}.cmp-out .hunk.cur{outline:3px solid #c9a24a;outline-offset:1px}
.cmp-out .sp{border-bottom:1px dotted #9aa6b8}.cmp-out .br{font-size:.8em}.muted{color:#5d6678;font-size:13px}`;

function readTxt(file) {
  return file.arrayBuffer().then(buf => {
    let t = new TextDecoder('utf-8').decode(buf);
    const bad = (t.match(/\uFFFD/g) || []).length;
    if (bad > 3 && bad > t.length / 200) { try { t = new TextDecoder('windows-1255').decode(buf); } catch {} }
    return t.replace(/^\uFEFF/, '');
  });
}
function download(data, name, type) { const b = new Blob([data], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }

function setupCompare() {
  const card = $('#compareCard'); if (!card) return;
  const ta = $('#cmpA'), tb = $('#cmpB'), msg = $('#cmpMsg'), out = $('#cmpOut'), list = $('#cmpList');
  const names = { a: 'Text A', b: 'Text B' };
  const opt = () => ({ nikud: $('#cmpNikud').checked, punct: $('#cmpPunct').checked, spacing: $('#cmpSpace').checked, labels: $('#cmpLabels').checked });
  let res = null, cur = -1;
  const say = (t, c = '') => { msg.textContent = t; msg.className = 'msg ' + c; };
  const ocrText = () => (window.__hocr && window.__hocr.ocrText) ? window.__hocr.ocrText() : '';
  function useOcr() {
    const t = ocrText();
    if (!t.trim()) { say('No OCR text yet. Read some pages first (steps 2 and 3), or paste Text A yourself.', 'warn'); return false; }
    ta.value = t; names.a = 'OCR result (this page)'; say('Text A = the current OCR result (with your corrections). It is only copied here; the OCR text is not changed.', 'ok'); return true;
  }
  $('#cmpUseOcr').onclick = useOcr;
  const goBtn = $('#btnCompareOcr'); if (goBtn) goBtn.onclick = () => { useOcr(); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => tb.focus(), 400); };
  const fileIn = (inp, box, side) => { inp.onchange = async () => { const f = inp.files[0]; if (!f) return; box.value = await readTxt(f); names[side] = f.name; inp.value = ''; say(`Loaded ${f.name}.`, 'ok'); }; };
  fileIn($('#cmpFileA'), ta, 'a'); fileIn($('#cmpFileB'), tb, 'b');
  ta.oninput = () => { names.a = 'Text A'; }; tb.oninput = () => { names.b = 'Text B'; };
  $('#cmpSwap').onclick = () => { [ta.value, tb.value] = [tb.value, ta.value]; [names.a, names.b] = [names.b, names.a]; if (res) run(); };
  function select(k, scroll = true) {
    if (!res || !res.stats.diffs) return; cur = (k + res.stats.diffs) % res.stats.diffs;
    out.querySelectorAll('.hunk.cur').forEach(e => e.classList.remove('cur')); list.querySelectorAll('li.cur').forEach(e => e.classList.remove('cur'));
    const el = out.querySelector('#dif' + cur); if (el) { el.classList.add('cur'); if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    const li = list.querySelector(`li[data-k="${cur}"]`); if (li) li.classList.add('cur');
    $('#cmpPos').textContent = `${cur + 1} / ${res.stats.diffs}`;
  }
  function run() {
    if (!ta.value.trim() || !tb.value.trim()) { say('Put a text in both boxes first.', 'warn'); return; }
    const t0 = performance.now(); res = compareTexts(ta.value, tb.value, opt()); cur = -1;
    const st = res.stats, s = summaryText(st);
    $('#cmpSummary').innerHTML = `<b>${st.diffs ? s.pct + '% of letters differ' : 'No differences'}</b> <span class="muted">(${st.letterErr} of ${st.lettersB} letters in B)</span> · <b>${st.changed}</b> words changed · <b>${st.added}</b> added in B · <b>${st.missing}</b> missing from B` + (st.spaceOnly ? ` · <span class="muted">${st.spaceOnly} spacing-only, ignored</span>` : '');
    out.innerHTML = renderDiff(res) || '<span class="muted">(empty)</span>';
    const rows = listRows(res, 1000);
    list.innerHTML = rows.map((r, i) => `<li data-k="${r.k}" tabindex="0"><span class="n">${i + 1}</span><bdi dir="rtl" class="a">${esc(r.a)}</bdi><span class="arr">→</span><bdi dir="rtl" class="b">${esc(r.b)}</bdi></li>`).join('') + (st.diffs > rows.length ? `<li class="muted">… and ${st.diffs - rows.length} more (all are in the report)</li>` : '');
    $('#cmpResult').classList.remove('hidden'); $('#cmpListBox').classList.toggle('hidden', !st.diffs);
    $('#cmpPos').textContent = st.diffs ? `0 / ${st.diffs}` : '';
    ['#cmpPrev', '#cmpNext'].forEach(b => $(b).disabled = !st.diffs);
    say(`Compared ${st.wordsA} words with ${st.wordsB} words in ${Math.round(performance.now() - t0)} ms.`, 'ok');
  }
  $('#cmpRun').onclick = run;
  ['#cmpNikud', '#cmpPunct', '#cmpSpace', '#cmpLabels'].forEach(id => $(id).onchange = () => { if (res) run(); });
  $('#cmpNext').onclick = () => select(cur + 1); $('#cmpPrev').onclick = () => select(cur < 0 ? -1 : cur - 1);
  const pick = e => { const h = e.target.closest('.hunk, li[data-k]'); if (h) select(+h.dataset.k, h.tagName === 'LI'); };
  out.onclick = pick; list.onclick = pick;
  out.onkeydown = list.onkeydown = e => { if (e.key === 'Enter') pick(e); };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  $('#cmpHtml').onclick = () => { if (res) download(htmlReport(res, opt(), names, REPORT_CSS), `compare-${stamp()}.html`, 'text/html;charset=utf-8'); };
  $('#cmpTxt').onclick = () => { if (res) download(textReport(res, opt(), names), `compare-${stamp()}.txt`, 'text/plain;charset=utf-8'); };
  $('#cmpClear').onclick = () => { ta.value = tb.value = ''; res = null; $('#cmpResult').classList.add('hidden'); say(''); };
  window.__hcmp = { run, compareTexts, get res() { return res; } };
}

// Script switch (Auto / Rashi / Square) as big buttons; they set the existing select, so OCR works exactly as before.
function setupScriptSwitch() {
  const sel = $('#scriptSel'), box = $('#scriptSwitch'); if (!sel || !box) return;
  const btns = [...box.querySelectorAll('button')];
  const show = () => btns.forEach(b => { const on = b.dataset.v === sel.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  btns.forEach(b => b.onclick = () => { if (sel.value === b.dataset.v) return; sel.value = b.dataset.v; sel.dispatchEvent(new Event('change')); show(); });
  sel.addEventListener('change', show); show();
}
if (typeof document !== 'undefined') { setupScriptSwitch(); setupCompare(); }
