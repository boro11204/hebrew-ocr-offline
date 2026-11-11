// Page cleanup before OCR (hebocr v7): keep only the main text block.
// Finds the text lines of each column and removes what is not body text:
// running headers and page numbers above the text, catchwords / signature marks below it,
// lines cut in half at the edge of a photo or crop, marginal notes and ink outside the text block,
// specks, and scanner borders. Plain code, no AI, runs in the browser.
function components(b, w, h) {
  const parent = []; const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const rows = new Array(h); let prev = [];
  for (let y = 0; y < h; y++) {
    const cur = []; const o = y * w; let x = 0;
    while (x < w) { if (b[o + x] !== 0) { x++; continue; } const x0 = x; while (x < w && b[o + x] === 0) x++; const id = parent.length; parent.push(id); cur.push([x0, x - 1, id]); }
    let j = 0;
    for (const r of cur) {
      while (j < prev.length && prev[j][1] < r[0] - 1) j++;
      for (let k = j; k < prev.length && prev[k][0] <= r[1] + 1; k++) { const a = find(r[2]), c = find(prev[k][2]); if (a !== c) { if (a < c) parent[c] = a; else parent[a] = c; } }
    }
    rows[y] = cur; prev = cur;
  }
  const map = new Map(); const cc = [];
  for (let y = 0; y < h; y++) for (const r of rows[y]) {
    const root = find(r[2]); let c = map.get(root);
    if (c === undefined) { c = cc.length; map.set(root, c); cc.push({ x0: r[0], x1: r[1], y0: y, y1: y, n: 0 }); }
    const s = cc[c]; if (r[0] < s.x0) s.x0 = r[0]; if (r[1] > s.x1) s.x1 = r[1]; s.y1 = y; s.n += r[1] - r[0] + 1; r[3] = c;
  }
  return { cc, rows };
}
const med = a => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// b: Uint8 binary (0 = ink), w, h; pitch: line pitch in px (0 if unknown); cols: [[x0,x1],...]
// returns { remove: Uint8Array per component, rows, cc, notes: [...], cols: kept columns, bands }
export function cleanLayout(b, w, h, pitch, cols) {
  cols = cols.slice();
  const { cc, rows } = components(b, w, h);
  const notes = { header: 0, cut: 0, foot: 0, margin: 0, specks: 0, border: 0, column: 0 };
  const rm = new Uint8Array(cc.length);
  // letter size from the components themselves
  let hts = cc.filter(c => c.n >= 15).map(c => c.y1 - c.y0 + 1);
  if (pitch) hts = hts.filter(v => v >= pitch * 0.2 && v <= pitch * 1.1);
  const xh = Math.max(6, med(hts) || (pitch ? pitch * 0.5 : 20));
  if (!pitch) pitch = xh * 1.9;
  // 1. scanner borders, rules and blobs
  for (let i = 0; i < cc.length; i++) {
    const c = cc[i], bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const edge = c.x0 <= 1 || c.y0 <= 1 || c.x1 >= w - 2 || c.y1 >= h - 2;
    if (bh > 3.5 * pitch || bw > 12 * xh && bh < 0.35 * xh || edge && (bh > 2.2 * pitch || bw > 6 * xh)) { rm[i] = 1; notes.border++; }
  }
  // 2. specks: tiny and far from any letter
  const big = []; const G = Math.max(8, Math.round(xh)); const gw = Math.ceil(w / G) + 1, gh = Math.ceil(h / G) + 1; const grid = new Map();
  const minLetter = Math.max(6, 0.04 * xh * xh), speck = Math.max(3, 0.012 * xh * xh);
  for (let i = 0; i < cc.length; i++) if (!rm[i] && cc[i].n >= minLetter) { big.push(i); const c = cc[i]; for (let gy = Math.floor(c.y0 / G); gy <= Math.floor(c.y1 / G); gy++) for (let gx = Math.floor(c.x0 / G); gx <= Math.floor(c.x1 / G); gx++) { const k = gy * gw + gx; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); } }
  for (let i = 0; i < cc.length; i++) {
    if (rm[i] || cc[i].n >= speck) continue;
    const c = cc[i], R = 0.9 * xh; let near = false;
    for (let gy = Math.floor((c.y0 - R) / G); gy <= Math.floor((c.y1 + R) / G) && !near; gy++) for (let gx = Math.floor((c.x0 - R) / G); gx <= Math.floor((c.x1 + R) / G) && !near; gx++) { const a = grid.get(gy * gw + gx); if (!a) continue; for (const j of a) { const d = cc[j]; if (d.x0 - R <= c.x1 && c.x0 <= d.x1 + R && d.y0 - R <= c.y1 && c.y0 <= d.y1 + R) { near = true; break; } } }
    if (!near) { rm[i] = 2; notes.specks++; }
  }
  // 2b. columns from the letters themselves (gutter shadows and specks no longer hide the gap)
  {
    const YB = Math.max(4, Math.round(xh)); const nyb = Math.ceil(h / YB) + 1; const occ = new Uint8Array(w * 0 + 1); let nl = 0;
    const seen = new Uint32Array(w); const pr = new Float64Array(w); const tag = new Int32Array(w).fill(-1);
    const byY = []; for (let i = 0; i < cc.length; i++) { if (rm[i]) continue; const c = cc[i], hh = c.y1 - c.y0 + 1; if (hh < 0.3 * xh || hh > 2.5 * xh || c.n < minLetter) continue; byY.push(i); nl++; }
    byY.sort((p, q) => cc[p].y0 - cc[q].y0);
    // pr[x] = number of text rows (xh-high strips) with a letter covering column x
    const strips = new Map(); for (const i of byY) { const c = cc[i]; const yb = Math.floor((c.y0 + c.y1) / 2 / YB); let a = strips.get(yb); if (!a) strips.set(yb, a = []); a.push(i); }
    for (const [yb, ids] of strips) { for (const i of ids) { const c = cc[i]; for (let x = c.x0; x <= c.x1; x++) if (tag[x] !== yb) { tag[x] = yb; pr[x]++; } } }
    let mx = 0; for (let x = 0; x < w; x++) if (pr[x] > mx) mx = pr[x];
    if (nl > 50 && mx > 0) {
      const r = Math.max(2, Math.round(0.4 * xh)); const sp = new Float64Array(w); { let s = 0; for (let x = 0; x < w; x++) { s += pr[x]; if (x - 2 * r - 1 >= 0) s -= pr[x - 2 * r - 1]; sp[Math.max(0, x - r)] = s / (2 * r + 1); } }
      let L0 = 0, R0 = w - 1; while (L0 < w && sp[L0] < 0.1 * mx) L0++; while (R0 > 0 && sp[R0] < 0.1 * mx) R0--;
      const span = R0 - L0; const body = []; for (let x = L0; x <= R0; x++) body.push(sp[x]); const level = pct(body, 0.6);
      const cuts = [];
      let x = Math.round(L0 + 0.15 * span);
      while (x < R0 - 0.15 * span) {
        if (sp[x] < 0.2 * level) { const a0 = x; while (x < R0 && sp[x] < 0.2 * level) x++; const z0 = x; let best = a0; for (let q = a0; q < z0; q++) if (sp[q] < sp[best]) best = q; if (z0 - a0 >= 0.5 * xh) cuts.push(Math.round((a0 + z0) / 2)); }
        x++;
      }
      if (!cuts.length) { let bq = -1; for (let q = Math.round(L0 + 0.3 * span); q < R0 - 0.3 * span; q++) if (bq < 0 || sp[q] < sp[bq]) bq = q;
        if (bq >= 0 && sp[bq] < 0.35 * level) { let a0 = bq, z0 = bq; while (a0 > L0 && sp[a0 - 1] < 0.5 * level) a0--; while (z0 < R0 && sp[z0 + 1] < 0.5 * level) z0++; if (z0 - a0 + 1 >= 0.5 * xh) cuts.push(Math.round((a0 + z0) / 2)); } }
      const cs = [0, ...cuts, w]; const nc = [];
      if (cuts.length) { cs[0] = Math.max(0, Math.round(L0 - 1.5 * xh)); cs[cs.length - 1] = Math.min(w, Math.round(R0 + 1.5 * xh)); }
      for (let i = 0; i + 1 < cs.length; i++) if (cs[i + 1] - cs[i] > 0.15 * span) nc.push([cs[i], cs[i + 1]]);
      // v8: the letter-based columns win when they find at least as many columns as the pixel-gutter guess,
      // and a pixel-gutter cut with letters running through it (no real gap) is dropped. (Auto mode on page 25
      // had a false cut beside the right margin, which hid the real gutter and read both columns as one.)
      const realGap = cx => { const q0 = Math.max(0, Math.round(cx - 0.6 * xh)), q1 = Math.min(w - 1, Math.round(cx + 0.6 * xh)); let m = Infinity; for (let q = q0; q <= q1; q++) m = Math.min(m, sp[q]); return m < 0.35 * level; };
      const oldCuts = cols.map(c => c[0]).filter(x => x > 0).filter(x => x > L0 && x < R0);
      const falseCut = oldCuts.some(cx => !realGap(cx));
      if (nc.length > cols.length || (nc.length >= 2 && nc.length === cols.length) || falseCut) { cols = nc.slice().reverse(); notes.columnsFound = cols.length; }
    }
  }
  // 3. text lines of each column
  const colInfo = [];
  const ccOfCol = cols.map(() => []);
  for (let i = 0; i < cc.length; i++) { if (rm[i]) continue; const cx = (cc[i].x0 + cc[i].x1) / 2; for (let k = 0; k < cols.length; k++) if (cx >= cols[k][0] && cx < cols[k][1]) { ccOfCol[k].push(i); break; } }
  if (notes.columnsFound) for (let i = 0; i < cc.length; i++) { if (rm[i]) continue; const cx = (cc[i].x0 + cc[i].x1) / 2; if (!cols.some(([a, z]) => cx >= a && cx < z)) { rm[i] = 6; notes.margin++; } }
  for (let k = 0; k < cols.length; k++) {
    const [cx0, cx1] = cols[k]; const ids = ccOfCol[k].filter(i => cc[i].y1 - cc[i].y0 + 1 >= 0.25 * xh);
    const prof = new Float64Array(h);
    for (const i of ids) { const c = cc[i]; const hh = c.y1 - c.y0 + 1; const v = c.n / hh; const a = Math.round(c.y0 + 0.3 * Math.min(hh, xh)), z = Math.round(c.y1 - 0.3 * Math.min(hh, xh)); for (let y = a; y <= Math.max(a, z); y++) prof[y] += v; }
    const sm = new Float64Array(h); for (let y = 0; y < h; y++) { let s = 0, n = 0; for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < h) { s += prof[y + d]; n++; } sm[y] = s / n; }
    const pos = Array.from(sm).filter(v => v > 0); const th = 0.12 * pct(pos, 0.9);
    let bands = []; let y = 0;
    while (y < h) { if (sm[y] <= th) { y++; continue; } const y0 = y; while (y < h && sm[y] > th) y++; bands.push({ y0, y1: y - 1 }); }
    // merge small splits, drop slivers
    const mg = []; for (const B of bands) { const L = mg[mg.length - 1]; if (L && B.y0 - L.y1 < 0.15 * xh) L.y1 = B.y1; else mg.push(B); }
    bands = mg.filter(B => B.y1 - B.y0 + 1 >= 0.15 * xh);
    for (const B of bands) {
      B.ids = ids.filter(i => { const cy = (cc[i].y0 + cc[i].y1) / 2; return cy >= B.y0 && cy <= B.y1; });
      const xs = []; for (const i of B.ids) xs.push(cc[i].x0, cc[i].x1);
      B.xl = pct(xs, 0.02); B.xr = pct(xs, 0.98); B.h = pct(B.ids.map(i => cc[i].y1 - cc[i].y0 + 1).filter(v => v >= 0.3 * xh), 0.75) || (B.y1 - B.y0 + 1); B.ext = B.y1 - B.y0 + 1; B.top = pct(B.ids.map(i => cc[i].y0), 0.1); B.bot = pct(B.ids.map(i => cc[i].y1), 0.9); B.wd = Math.max(1, B.xr - B.xl);
      let ink = 0; for (const i of B.ids) ink += cc[i].x1 - cc[i].x0 + 1; B.dn = ink / B.wd;
    }
    colInfo.push({ k, bands });
  }
  const allH = colInfo.flatMap(c => c.bands.map(B => B.h));
  const Hall = med(allH);
  const dropBand = (B, why) => { for (const i of B.ids) if (!rm[i]) rm[i] = 3; notes[why]++; B.drop = why; };
  for (const C of colInfo) {
    const bs = C.bands; if (bs.length < 4) continue;
    const core = bs.filter(B => B.h >= 0.5 * Hall && B.h <= 1.7 * Hall);
    if (core.length < 3) continue;
    const Em = med(core.map(B => B.ext)), Hm = med(core.map(B => B.h)), Wm = med(core.map(B => B.wd)), Rm = med(core.map(B => B.xr)), Lm = med(core.map(B => B.xl)), Dm = med(core.map(B => B.dn));
    const gaps = []; for (let i = 1; i < bs.length; i++) gaps.push(bs[i].y0 - bs[i - 1].y1); const Gm = Math.max(1, med(gaps));
    const tol = Math.max(3, 0.5 * xh);
    let live = bs.slice();
    // top: a line cut by the edge of the image, then a running header / page number
    for (let t = 0; t < 3 && live.length > 3; t++) {
      const B = live[0], N = live[1], gap = N.y0 - B.y1;
      const cut = B.top <= tol && (B.ext < 0.6 * Em || B.h < 0.72 * Hm || B.dn < 0.6 * Dm);
      const head = gap > Math.max(1.6 * Gm, Gm + 0.3 * Hm) && (B.dn < 0.7 * Dm || B.wd < 0.75 * Wm || B.h > 1.35 * Hm || B.h < 0.6 * Hm);
      if (cut) { dropBand(B, 'cut'); live.shift(); continue; }
      if (head) { dropBand(B, 'header'); live.shift(); continue; }
      break;
    }
    // bottom: a cut line, a catchword (short, at the left end), a signature mark or page number
    for (let t = 0; t < 3 && live.length > 3; t++) {
      const B = live[live.length - 1], P = live[live.length - 2], gap = B.y0 - P.y1;
      const cut = B.bot >= h - 1 - tol && (B.ext < 0.6 * Em || B.h < 0.72 * Hm || B.dn < 0.6 * Dm);
      const catchw = bs.length >= 20 && B.wd < 0.3 * Wm && B.xr < Rm - 0.5 * Wm && B.xl <= Lm + 0.25 * Wm;
      const sig = gap > Math.max(1.6 * Gm, Gm + 0.3 * Hm) && B.wd < 0.5 * Wm || bs.length >= 20 && B.dn < 0.3 * Dm;
      if (cut) { dropBand(B, 'cut'); live.pop(); continue; }
      if (catchw || sig) { dropBand(B, 'foot'); live.pop(); continue; }
      break;
    }
    // ink beside the text block (marginal notes, edges of the next column)
    // (only pieces cut by the edge of the column/photo, or far away; section letters that hang in the margin stay)
    const lo = Lm - 1.5 * xh, hi = Rm + 1.5 * xh, [ex0, ex1] = cols[C.k];
    for (const B of live) for (const i of B.ids) { const c = cc[i]; if (rm[i] || !(c.x1 < lo || c.x0 > hi)) continue; const atEdge = c.x0 <= ex0 + 2 || c.x1 >= ex1 - 3; const far = c.x1 < Lm - 6 * xh || c.x0 > Rm + 6 * xh; if (atEdge || far) { rm[i] = 4; notes.margin++; } }
    C.Wm = Wm; C.Hm = Hm; C.live = live.length;
  }
  // 4. a narrow column of small print beside wide ones = marginal notes
  let keepCols = cols.map((c, k) => k);
  const wides = colInfo.filter(C => C.Wm).map(C => C.Wm); const Wmax = Math.max(0, ...wides);
  if (cols.length > 1 && Wmax) keepCols = keepCols.filter(k => { const C = colInfo[k]; if (C.Wm && C.Wm < 0.3 * Wmax && C.Hm < 0.85 * Hall) { for (const i of ccOfCol[k]) if (!rm[i]) rm[i] = 5; notes.column++; return false; } return true; });
  return { rm, cc, rows, notes, keepCols, xh, colInfo, cols };
}

// whiten removed components in the binary and gray images (in place); returns how many pixels were cleared
export function applyClean(res, b, g, w, h) {
  const { rm, rows } = res; let n = 0;
  for (let y = 0; y < h; y++) for (const r of rows[y]) {
    if (!rm[r[3]]) continue;
    const pad = rm[r[3]] === 2 ? 1 : 2;
    for (let yy = Math.max(0, y - pad); yy <= Math.min(h - 1, y + pad); yy++) { const o = yy * w; for (let x = Math.max(0, r[0] - pad); x <= Math.min(w - 1, r[1] + pad); x++) { if (yy === y && x >= r[0] && x <= r[1]) n++; b[o + x] = 255; if (g) g[o + x] = 255; } }
  }
  return n;
}
export function cleanSummary(notes) {
  const p = []; const s = (n, one, many) => n ? p.push(`${n} ${n === 1 ? one : many}`) : 0;
  s(notes.header, 'header line', 'header lines'); s(notes.cut, 'half-cut line at the edge', 'half-cut lines at the edge'); s(notes.foot, 'catchword/page mark', 'catchwords/page marks');
  s(notes.column, 'margin-note column', 'margin-note columns'); s(notes.margin, 'mark beside the text', 'marks beside the text'); s(notes.specks, 'speck', 'specks'); s(notes.border, 'border/rule', 'borders/rules');
  return p.length ? 'page cleanup: removed ' + p.join(', ') : 'page cleanup: nothing to remove';
}
