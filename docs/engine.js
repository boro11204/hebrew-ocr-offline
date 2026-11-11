// Hebrew OCR — offline engine (no AI). Runs fully in the browser.
// Preprocessing (deskew, adaptive binarization, denoise, line straightening, column detection,
// v7: page cleanup — headers, page numbers, catchwords, margin notes, specks and borders removed before reading;
// v8: column fix, re-reading lines a stain or fold made Tesseract skip, black & white fallback for faint scans),
// Tesseract.js with two Apache-2.0 models (Google's tessdata_best "heb" and pninim.org's "heb_rashi"),
// line-by-line voting between them, and word-list post-correction tuned for Rashi letter confusions.
// Everything here is plain code: no key, no server, no AI.

import { cleanLayout, applyClean, cleanSummary } from './layout.js?v=13';
const TESS_BASE = new URL('./vendor/tess/', import.meta.url).href;
const LANG_BASE = new URL('./tessdata', import.meta.url).href;
// v4 (Nov 2026): both models fine-tuned on real printed lines (Vilna Shas 1925 + Prague 1815), see github.com/boro11204/hebrew-ocr-offline
const L_SQ = (typeof window !== 'undefined' && window.__HOCR_SQ) || 'heb4', L_RASHI = (typeof window !== 'undefined' && window.__HOCR_RASHI) || 'heb_rashi7';
// v4 models read the cleaned gray image better than the black & white one (measured on Vilna RH 2a)
const USE_GRAY = !(typeof window !== 'undefined' && window.__HOCR_GRAY === false);
export const ENGINE_MODELS = { [L_SQ]: 'Hebrew (square script) — tessdata_best heb, fine-tuned (hebocr v4)', [L_RASHI]: 'Rashi script — pninim.org heb_rashi, fine-tuned on worn prints and look-alike letters (hebocr v7)' };

// ---------------------------------------------------------------- loading
let tessLoading;
function loadTesseract() {
  return tessLoading ||= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script'); s.src = TESS_BASE + 'tesseract.min.js';
    s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('Could not load the OCR engine files.')); document.head.appendChild(s);
  });
}
const workers = {};
export async function getWorker(lang, onStatus) {
  if (workers[lang]) return workers[lang];
  workers[lang] = (async () => {
    const T = await loadTesseract();
    const w = await T.createWorker(lang, 1, {
      workerPath: TESS_BASE + 'worker.min.js', corePath: TESS_BASE, langPath: LANG_BASE, gzip: false,
      logger: m => { if (onStatus && m.status && /loading|initializ/.test(m.status)) onStatus(`Engine: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`); },
    });
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  })();
  try { return await workers[lang]; } catch (e) { delete workers[lang]; throw e; }
}
let wordsLoading; let RANK = null;
export function loadWords() {
  return wordsLoading ||= fetch(LANG_BASE + '/words.txt').then(r => { if (!r.ok) throw new Error('word list ' + r.status); return r.text(); })
    .then(t => { RANK = new Map(); t.split('\n').forEach((w, i) => { if (w) RANK.set(w, i); }); return RANK; });
}

// ---------------------------------------------------------------- image helpers
export function canvasFrom(src, w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); if (src) g.drawImage(src, 0, 0, w, h); return c; }
function grayOf(c) { const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; const n = c.width * c.height; const g = new Uint8ClampedArray(n); for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000; return g; }
function grayToCanvas(g, w, h) { const c = canvasFrom(null, w, h); const ctx = c.getContext('2d'); const id = ctx.createImageData(w, h); for (let i = 0, j = 0; i < g.length; i++, j += 4) { id.data[j] = id.data[j + 1] = id.data[j + 2] = g[i]; id.data[j + 3] = 255; } ctx.putImageData(id, 0, 0); return c; }
export function otsu(g) { const h = new Float64Array(256); for (let i = 0; i < g.length; i++) h[g[i]]++; let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i]; let sB = 0, wB = 0, best = 0, t = 128; const n = g.length; for (let i = 0; i < 256; i++) { wB += h[i]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += i * h[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; t = i; } } return t; }
function autocontrast(g) { const h = new Uint32Array(256); for (let i = 0; i < g.length; i++) h[g[i]]++; const cut = g.length * 0.01; let lo = 0, hi = 255, a = 0; while (lo < 255 && (a += h[lo]) < cut) lo++; a = 0; while (hi > 0 && (a += h[hi]) < cut) hi--; if (hi <= lo) return g; const s = 255 / (hi - lo); for (let i = 0; i < g.length; i++) g[i] = (g[i] - lo) * s; return g; }
function median3(g, w, h) { const o = new Uint8ClampedArray(g.length); const v = new Uint8Array(9); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let k = 0; for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy)); for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); v[k++] = g[yy * w + xx]; } } v.sort(); o[y * w + x] = v[4]; } return o; }
// Sauvola adaptive threshold with integral images (handles shadows and uneven light from phone photos)
function sauvola(g, w, h, win, k = 0.2) { const W1 = w + 1; const S = new Float64Array(W1 * (h + 1)), S2 = new Float64Array(W1 * (h + 1)); for (let y = 0; y < h; y++) { let r = 0, r2 = 0; for (let x = 0; x < w; x++) { const v = g[y * w + x]; r += v; r2 += v * v; S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + r; S2[(y + 1) * W1 + x + 1] = S2[y * W1 + x + 1] + r2; } } const o = new Uint8ClampedArray(g.length); const hw = win >> 1; for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - hw), y1 = Math.min(h, y + hw + 1); for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - hw), x1 = Math.min(w, x + hw + 1); const n = (y1 - y0) * (x1 - x0); const s = S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0]; const s2 = S2[y1 * W1 + x1] - S2[y0 * W1 + x1] - S2[y1 * W1 + x0] + S2[y0 * W1 + x0]; const m = s / n; const sd = Math.sqrt(Math.max(0, s2 / n - m * m)); o[y * w + x] = g[y * w + x] > m * (1 + k * (sd / 128 - 1)) ? 255 : 0; } } return o; }
function binarizeOtsu(g) { const t = otsu(g); const o = new Uint8ClampedArray(g.length); for (let i = 0; i < g.length; i++) o[i] = g[i] > t ? 255 : 0; return o; }
// uneven lighting? compare mean brightness of a coarse grid
function unevenLight(g, w, h) { const N = 6, means = []; for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) { let s = 0, n = 0; for (let y = Math.floor(gy * h / N); y < Math.floor((gy + 1) * h / N); y += 4) for (let x = Math.floor(gx * w / N); x < Math.floor((gx + 1) * w / N); x += 4) { s += g[y * w + x]; n++; } means.push(s / Math.max(1, n)); } means.sort((a, b) => a - b); return means[means.length - 2] - means[1]; }
// distance between text lines, from the autocorrelation of the row ink profile
export function linePitch(g, w, h) { const t = otsu(g); const ink = new Float64Array(h); for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x += 2) if (g[y * w + x] < t) s++; ink[y] = s; } let m = 0; for (const v of ink) m += v; m /= h; for (let y = 0; y < h; y++) ink[y] -= m; let a0 = 0; for (const v of ink) a0 += v * v; if (!a0) return 0; let prev = 1, cur = 1; const ac = k => { let s = 0; for (let y = 0; y + k < h; y++) s += ink[y] * ink[y + k]; return s / a0; }; let p = ac(4), c = ac(5); for (let k = 5; k < Math.min(h - 1, 300); k++) { const n = ac(k + 1); if (c > p && c >= n && c > 0.15) return k; p = c; c = n; } return 0; }
// skew angle (degrees) that makes text lines most horizontal
function skewAngle(b, w, h) { const pts = []; const step = Math.max(1, Math.floor(Math.sqrt(w * h / 150000))); for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (b[y * w + x] === 0) pts.push(x, y); let best = 0, bestS = -1; const hist = new Float64Array(h + w + 10); for (let a = -5; a <= 5.001; a += 0.25) { const t = a * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t); hist.fill(0); for (let i = 0; i < pts.length; i += 2) { const yy = Math.round(pts[i + 1] * cs - pts[i] * sn + w); if (yy >= 0 && yy < hist.length) hist[yy]++; } let s = 0; for (let i = 1; i < hist.length; i++) s += (hist[i] - hist[i - 1]) ** 2; if (s > bestS) { bestS = s; best = a; } } return best; }
function rotateCanvas(c, deg) { const t = deg * Math.PI / 180; const w = c.width, h = c.height; const W = Math.round(Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t))), H = Math.round(Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t))); const o = canvasFrom(null, W, H); const g = o.getContext('2d'); g.translate(W / 2, H / 2); g.rotate(t); g.drawImage(c, -w / 2, -h / 2); return o; }
// gentle "dewarp": find how far each vertical strip's text lines sit above/below the middle strip
// (curved lines near a book's spine) and shift pixel columns back. Only applied when the bend is clear.
function straightenLines(g, w, h, pitch) { const N = 8, sw = Math.floor(w / N); if (sw < 40 || !pitch) return { g, bend: 0 }; const t = otsu(g); const prof = []; for (let s = 0; s < N; s++) { const p = new Float64Array(h); for (let y = 0; y < h; y++) { let n = 0; for (let x = s * sw; x < (s + 1) * sw; x += 2) if (g[y * w + x] < t) n++; p[y] = n; } let m = 0; for (const v of p) m += v; m /= h; for (let y = 0; y < h; y++) p[y] -= m; prof.push(p); } const ref = prof[N >> 1]; const maxS = Math.floor(pitch * 0.45); const off = []; for (let s = 0; s < N; s++) { let best = 0, bs = -Infinity; for (let d = -maxS; d <= maxS; d++) { let sc = 0; for (let y = Math.max(0, -d); y < Math.min(h, h - d); y += 2) sc += prof[s][y + d] * ref[y]; if (sc > bs) { bs = sc; best = d; } } off.push(best); } const span = Math.max(...off) - Math.min(...off); if (span < Math.max(4, pitch * 0.12)) return { g, bend: 0 }; // small wiggles are noise on a flat page // fit a parabola through strip centres
  const xs = off.map((_, s) => (s + 0.5) * sw); let A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0]; xs.forEach((x, i) => { const v = [1, x, x * x]; for (let r = 0; r < 3; r++) { B[r] += v[r] * off[i]; for (let q = 0; q < 3; q++) A[r][q] += v[r] * v[q]; } }); const sol = solve3(A, B); if (!sol) return { g, bend: 0 }; let res = 0; xs.forEach((x, i) => { res += Math.abs(sol[0] + sol[1] * x + sol[2] * x * x - off[i]); }); if (res / N > 2) return { g, bend: 0 }; // not a smooth bend: leave it
  const o = new Uint8ClampedArray(g.length).fill(255); for (let x = 0; x < w; x++) { const d = Math.round(sol[0] + sol[1] * x + sol[2] * x * x); for (let y = 0; y < h; y++) { const yy = y + d; if (yy >= 0 && yy < h) o[y * w + x] = g[yy * w + x]; } } return { g: o, bend: span }; }
function solve3(A, B) { const M = A.map((r, i) => [...r, B[i]]); for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; if (Math.abs(M[c][c]) < 1e-12) return null; for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let q = c; q < 4; q++) M[r][q] -= f * M[c][q]; } } return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]; }
// columns: wide white gutters that run down most of the page. Returned right-to-left (Hebrew order).
export function findColumns(b, w, h) { const col = new Float64Array(w); const y0 = Math.floor(h * 0.04), y1 = Math.floor(h * 0.96); for (let x = 0; x < w; x++) { let n = 0; for (let y = y0; y < y1; y += 2) if (b[y * w + x] === 0) n++; col[x] = n / ((y1 - y0) / 2); } const minGap = Math.max(12, Math.floor(w * 0.012)); const gaps = []; let run = 0; for (let x = 0; x < w; x++) { if (col[x] < 0.004) run++; else { if (run >= minGap) gaps.push([x - run, x]); run = 0; } } const inner = gaps.filter(([a, z]) => a > w * 0.06 && z < w * 0.94); const cuts = [0, ...inner.map(([a, z]) => Math.round((a + z) / 2)), w]; let cols = []; for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > w * 0.12) cols.push([cuts[i], cuts[i + 1]]); if (!cols.length) cols = [[0, w]]; return cols.reverse(); }


// Lanczos-3 resize of a grayscale array (sharper letter edges than the canvas's own scaling; measured better OCR)
function lanczosResize(g, w, h, W, H) {
  const a = 3; const k = x => { if (x === 0) return 1; if (Math.abs(x) >= a) return 0; const px = Math.PI * x; return a * Math.sin(px) * Math.sin(px / a) / (px * px); };
  const pass = (src, sw, sh, dw, horizontal) => { // resize along one axis
    const n = horizontal ? sw : sh, m = dw, other = horizontal ? sh : sw; const out = new Float32Array(horizontal ? dw * sh : sw * dw);
    const scale = m / n, fs = Math.max(1, 1 / scale), sup = a * fs; const taps = [];
    for (let i = 0; i < m; i++) { const c = (i + 0.5) / scale - 0.5; const lo = Math.floor(c - sup) + 1, hi = Math.floor(c + sup); const ws = []; let sum = 0; for (let j = lo; j <= hi; j++) { const wt = k((j - c) / fs); ws.push([Math.min(n - 1, Math.max(0, j)), wt]); sum += wt; } taps.push(ws.map(([j, wt]) => [j, wt / sum])); }
    for (let o = 0; o < other; o++) for (let i = 0; i < m; i++) { let s = 0; for (const [j, wt] of taps[i]) s += wt * (horizontal ? src[o * sw + j] : src[j * sw + o]); if (horizontal) out[o * dw + i] = s; else out[i * sw + o] = s; }
    return out; };
  const t = pass(g, w, h, W, true); const o = pass(t, W, h, H, false); const r = new Uint8ClampedArray(W * H); for (let i = 0; i < r.length; i++) r[i] = o[i]; return r;
}

// full preprocessing. opts: { script: 'square'|'rashi'|'mixed', binarize: 'auto'|'otsu'|'adaptive', straighten: bool }
export function preprocess(srcCanvas, opts = {}) {
  const steps = []; let c = srcCanvas; let w = c.width, h = c.height;
  let g = grayOf(c); const pitch0 = linePitch(g, w, h);
  // v4 models were trained on lines at their scanned size (~30-45 px line pitch at 300 dpi); the old models liked ~120 px
  const target = (typeof window !== 'undefined' && window.__HOCR_TARGET) || (opts.script === 'rashi' ? 70 : 45);
  let scale = pitch0 ? Math.min(4, Math.max(1, target / pitch0)) : 1;
  const maxPx = 36e6, maxSide = 9000; scale = Math.min(scale, Math.sqrt(maxPx / (w * h)), maxSide / Math.max(w, h)); if (scale < 1) scale = Math.max(scale, 0.25);
  if (Math.abs(scale - 1) > 0.05) { const W2 = Math.round(w * scale), H2 = Math.round(h * scale); g = scale > 1 ? lanczosResize(g, w, h, W2, H2) : grayOf(canvasFrom(c, W2, H2)); w = W2; h = H2; steps.push(`${scale > 1 ? 'enlarged' : 'reduced'} ×${scale.toFixed(1)}`); }
  autocontrast(g); g = median3(g, w, h); steps.push('contrast + denoise');
  const ang = skewAngle(binarizeOtsu(g), w, h);
  if (Math.abs(ang) >= 0.25) { c = rotateCanvas(grayToCanvas(g, w, h), -ang); w = c.width; h = c.height; g = grayOf(c); steps.push(`deskewed ${ang > 0 ? '+' : ''}${ang.toFixed(2)}°`); }
  const pitch = pitch0 * scale;
  if (opts.straighten !== false) { const r = straightenLines(g, w, h, pitch); if (r.bend) { g = r.g; steps.push(`straightened curved lines (${r.bend}px)`); } }
  const gray = g;
  let mode = opts.binarize || 'auto'; if (mode === 'auto') mode = 'adaptive'; // adaptive measured better on both test pages; 'otsu' stays as an option
  const b = mode === 'adaptive' ? sauvola(g, w, h, (Math.max(15, Math.round((pitch || 40) * 0.6)) | 1)) : binarizeOtsu(g);
  steps.push(mode === 'adaptive' ? 'adaptive black & white' : 'black & white');
  let cols = opts.columns === false ? [[0, w]] : findColumns(b, w, h);
  // v7 page cleanup (on by default): keep only the main text block
  const noClean = typeof window !== 'undefined' && window.__HOCR_NOCLEAN;
  let clean = null; let bands = null;
  if (opts.clean !== false && !noClean && opts.columns !== false) {
    try { const r = cleanLayout(b, w, h, pitch, cols); applyClean(r, b, gray, w, h); cols = r.cols.filter((c, k) => r.keepCols.includes(k)); bands = cols.length ? r.keepCols.map(k => (r.colInfo[k] ? r.colInfo[k].bands : []).filter(B => !B.drop).map(B => [B.y0, B.y1])) : null; if (!cols.length) cols = [[0, w]]; clean = r.notes; steps.push(cleanSummary(r.notes)); }
    catch (e) { console.warn('page cleanup skipped: ' + e.message); steps.push('page cleanup skipped'); }
  }
  if (cols.length > 1) steps.push(`${cols.length} columns found`);
  return { bin: grayToCanvas(b, w, h), gray: grayToCanvas(gray, w, h), w, h, cols, steps, scale, angle: ang, clean, bands };
}

// ---------------------------------------------------------------- text helpers
const FIN = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' }; const UNFIN = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export function fixSofit(w) { if (w.length < 2) return w; let o = ''; for (let i = 0; i < w.length - 1; i++) o += UNFIN[w[i]] || w[i]; const l = w[w.length - 1]; return o + (FIN[l] || l); }
const LETTERS = /[\u05D0-\u05EA]/;
// look-alike pairs (Rashi script and worn print). Weight 1 = common confusion.
const PAIRS = [['ב','ש',1],['כ','ה',1],['ס','ש',1],['ם','ס',1],['ה','ח',1],['ח','ת',1],['ה','ת',1],['ב','כ',1],['ג','נ',1],['ד','ר',1],['ו','ז',1],['ו','י',1],['ו','ן',1],['י','ן',1],['ע','ט',1],['ע','צ',1],['ט','מ',1],['ש','פ',1],['א','ל',1],['ך','ן',1],['ף','ך',1],['ק','ה',.7],['ש','ט',1],['ג','ב',.7],['ו','ג',.5],['נ','כ',.7],['ח','מ',.7],['ת','ק',.7],['ד','ך',.5]];
const CONF = {}; for (const [a, b, wt] of PAIRS) { (CONF[a] ||= []).push([b, wt]); (CONF[b] ||= []).push([a, wt]); }
const SUBCOST = 2.0;
const logf = w => { const r = RANK.get(w); return r === undefined ? null : -Math.log(r + 10); };
function bestWord(core) { const cur = fixSofit(core); const b0 = logf(cur); let best = [b0 === null ? -99 : b0, cur]; let frontier = [[cur, 0]]; const depth = cur.length >= 4 ? 2 : 1; for (let d = 0; d < depth; d++) { const nf = []; for (const [w, cost] of frontier) { for (let i = 0; i < w.length; i++) { for (const [r, wt] of (CONF[w[i]] || [])) { const c = fixSofit(w.slice(0, i) + r + w.slice(i + 1)); const cc = cost + SUBCOST / wt; if (nf.length < 400) nf.push([c, cc]); const lf = logf(c); if (lf !== null && lf - cc > best[0]) best = [lf - cc, c]; } } } frontier = nf; } return best[1]; }
// word-list post-correction; returns { text, changes: [{from, to}] }
export function postCorrect(text) { if (!RANK) return { text, changes: [] }; const changes = []; const out = text.split('\n').map(line => line.split(' ').map(tok => { if (/[׳״'"]/.test(tok)) return tok; const core = tok.replace(/[^\u05D0-\u05EA]/g, ''); if (core.length < 2) return tok; const c = bestWord(core); if (c === core) return tok; changes.push({ from: core, to: c }); return tok.includes(core) ? tok.replace(core, c) : c; }).join(' ')).join('\n'); return { text: out, changes }; }
export function dictMass(t) { if (!RANK) return 0; return t.split(/\s+/).map(w => w.replace(/[^\u05D0-\u05EA]/g, '')).filter(w => w.length >= 2 && RANK.has(fixSofit(w))).reduce((s, w) => s + w.length, 0); }
function dictRatio(t) { if (!RANK) return 0; const ws = t.split(/\s+/).map(w => w.replace(/[^\u05D0-\u05EA]/g, '')).filter(w => w.length >= 2); if (!ws.length) return 0; return ws.filter(w => RANK.has(fixSofit(w))).length / ws.length; }
// Tesseract writes ' and " for geresh/gershayim; use the Hebrew marks between Hebrew letters
export function hebPunct(t) { return t.replace(/([\u05D0-\u05EA])"(?=[\u05D0-\u05EA])/g, '$1״').replace(/([\u05D0-\u05EA])'(?=[\s\u05D0-\u05EA:.,;]|$)/gm, '$1׳'); }


// ---------------------------------------------------------------- word model (v5, Nov 2026)
// Sefaria n-gram word model (60M words of rabbinic Hebrew/Aramaic, public texts; unigrams + bigrams, pruned)
// used as a beam re-scorer after OCR: each word may be swapped for a look-alike-letter variant when the
// variant is a real word that fits the neighbouring words better. Letter costs were learned from OCR errors
// on held-out dev lines. No source text is looked up: this is a general language model.
const LM_ALT = {"ס":[["ק",3.085],["ת",4.875],["מ",4.886],["ש",5.196],["ז",5.384],["ט",5.481],["כ",5.519]],"פ":[["ק",3.025],["ע",3.221],["ס",3.555],["ט",4.094],["כ",4.132],["מ",4.193],["ש",4.503]],"ו":[["ז",1.578],["ד",2.308],["י",2.441],["נ",2.802],["ג",3.773],["כ",4.315],["מ",4.375]],"נ":[["ג",3.08],["ל",4.094],["כ",4.22],["צ",4.727],["מ",4.886],["ע",5.167],["ס",5.347]],"ד":[["כ",3.622],["ר",4.81],["ק",5.165],["פ",5.389],["ח",5.787],["ה",5.973],["י",6.467]],"ז":[["צ",3.223],["א",4.76],["ט",5.481],["ד",5.849],["ק",5.858],["ו",5.973],["פ",6.082]],"ר":[["ד",2.499],["ח",3.59],["ג",4.466],["כ",4.671],["נ",4.863],["י",4.926],["ק",5.165]],"כ":[["ב",2.639],["מ",3.346],["פ",3.517],["ס",3.738],["נ",4.612],["ט",4.787],["ד",5.156]],"ח":[["ת",2.697],["ק",3.46],["ה",4.507],["מ",4.518],["ר",4.944],["ס",5.347],["ו",5.413]],"ל":[["צ",3.023],["פ",3.885],["ר",4.587],["א",4.76],["נ",4.863],["ג",5.159],["ע",5.167]],"ע":[["ט",2.842],["צ",3.223],["ש",3.286],["ג",4.06],["מ",4.088],["ח",4.401],["פ",4.984]],"ת":[["ח",2.954],["ק",3.219],["ה",4.299],["נ",5.71],["ר",5.791],["מ",5.985],["א",6.059]],"ט":[["ע",3.321],["מ",3.865],["נ",4.036],["ש",4.503],["כ",4.671],["ק",4.759],["ס",5.347]],"י":[["ו",4.363],["ז",4.691],["ג",5.159],["ע",5.167],["א",5.212],["נ",5.423],["ח",5.787]],"ב":[["צ",3.223],["מ",3.255],["ג",3.55],["כ",3.673],["ש",3.874],["ד",4.597],["נ",4.612]],"מ":[["ס",2.256],["ח",3.707],["ט",3.871],["פ",4.003],["נ",4.411],["א",4.45],["ג",4.466]],"א":[["ק",4.248],["ת",4.588],["ח",4.688],["ז",4.691],["צ",4.727],["ל",5.136],["פ",5.389]],"ש":[["ט",2.39],["ס",3.738],["מ",3.948],["ע",3.963],["ק",4.066],["פ",4.136],["ת",4.269]],"צ":[["ג",4.466],["ל",4.848],["ע",4.879],["ר",6.89],["ב",6.97],["מ",7.083],["א",7.158]],"ג":[["נ",3.718],["ל",5.136],["ב",5.178],["ז",5.384],["צ",5.421],["א",5.771],["ח",5.787]],"ה":[["ת",2.883],["ק",2.968],["ח",3.148],["ד",4.24],["ר",4.81],["כ",5.231],["י",5.368]],"ק":[["ת",5.568],["ה",5.973],["נ",6.809]],"ם":[]};
const LM_P = { lam: 1.0, cw: 1.2, oov: -20, bo: -0.9, minlen: 2, beam: 8, maxFrontier: 3000 };
let lmLoading; let LMU = null, LMB = null, LMLOGN = 0;
export function loadLM() {
  return lmLoading ||= Promise.all([fetch(LANG_BASE + '/lm_words.txt').then(r => { if (!r.ok) throw new Error('lm words ' + r.status); return r.text(); }), fetch(LANG_BASE + '/lm_bigrams.txt').then(r => { if (!r.ok) throw new Error('lm bigrams ' + r.status); return r.text(); })])
    .then(([wt, bt]) => {
      const U = new Map(); const ws = []; const L = wt.split('\n'); LMLOGN = Math.log(+L[0].slice(1));
      for (let i = 1; i < L.length; i++) { const l = L[i]; if (!l) continue; const t = l.indexOf('\t'); const w = l.slice(0, t); U.set(w, +l.slice(t + 1)); ws.push(w); }
      const B = new Map(); for (const l of bt.split('\n')) { if (!l) continue; const [a, b, c] = l.split(' '); B.set(ws[parseInt(a, 36)] + ' ' + ws[parseInt(b, 36)], parseInt(c, 36)); }
      LMU = U; LMB = B; return true;
    });
}
const lmFold = c => UNFIN[c] || c;
function lmCands(w) {
  const f = [...w].map(lmFold).join(''); const out = new Map([[w, 0]]); let fr = [[f, 0]]; const depth = w.length >= 4 ? 2 : 1;
  for (let d = 0; d < depth; d++) { const nf = []; for (const [s, cst] of fr) { for (let i = 0; i < s.length; i++) { const alts = LM_ALT[s[i]]; if (!alts) continue; for (const [t, c] of alts) { const s2 = s.slice(0, i) + t + s.slice(i + 1); const cc = cst + c; if (nf.length < LM_P.maxFrontier) nf.push([s2, cc]); const ws = fixSofit(s2); if (LMU.has(ws) && (!out.has(ws) || out.get(ws) > cc)) out.set(ws, cc); } } } fr = nf; }
  return out;
}
function lmLine(cores, prev) {
  const P = LM_P; let beams = new Map([[prev, [0, []]]]);
  for (const w of cores) {
    const nb = new Map();
    if (w.length < P.minlen) { const k = LMU.has(w) ? w : null; for (const [, [s, path]] of beams) { if (!nb.has(k) || nb.get(k)[0] < s) nb.set(k, [s, path.concat([w])]); } beams = nb; continue; }
    for (const [c, ccost] of lmCands(w)) {
      const uc = LMU.get(c); const ul = uc ? Math.log(uc) - LMLOGN : null;
      for (const [p, [s, path]] of beams) {
        let lm; const bc = p !== null ? LMB.get(p + ' ' + c) : undefined;
        if (bc && LMU.has(p)) lm = Math.log(bc / LMU.get(p)); else if (ul !== null) lm = P.bo + ul; else lm = P.bo + P.oov;
        const sc = s + P.lam * lm - P.cw * ccost; const key = uc ? c : null;
        if (!nb.has(key) || nb.get(key)[0] < sc) nb.set(key, [sc, path.concat([c])]);
      }
    }
    beams = new Map([...nb.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, P.beam));
  }
  let best = null; for (const e of beams) if (!best || e[1][0] > best[1][0]) best = e;
  return { path: best[1][1], prev: best[0] };
}
// returns { text, changes: [{from, to}] }
export function lmCorrect(text) {
  if (!LMU) return null; const changes = []; let prev = null;
  const out = text.split('\n').map(line => {
    const toks = line.split(' '); const cores = toks.map(t => { const core = t.replace(/[^\u05D0-\u05EA]/g, ''); return (/[׳״'"]/.test(t) || !core) ? '' : core; });
    const r = lmLine(cores, prev); prev = r.prev;
    return toks.map((t, i) => { const c = cores[i], n = r.path[i]; if (c && n !== c) { changes.push({ from: c, to: n }); return t.includes(c) ? t.replace(c, n) : n; } return t; }).join(' ');
  }).join('\n');
  return { text: out, changes };
}

// lines of one recognition, from Tesseract's block tree
function linesOf(data) { const out = []; for (const b of (data.blocks || [])) for (const p of (b.paragraphs || [])) { for (const l of (p.lines || [])) { const t = (l.words || []).map(x => x.text).join(' ').trim(); if (t) out.push({ y: (l.bbox.y0 + l.bbox.y1) / 2, h: l.bbox.y1 - l.bbox.y0, text: t, conf: l.confidence }); } out.push({ para: true }); } return out; }
function cropCanvas(c, x0, x1) { const o = canvasFrom(null, x1 - x0, c.height); o.getContext('2d').drawImage(c, x0, 0, x1 - x0, c.height, 0, 0, x1 - x0, c.height); return o; }


function cropRect(c, x0, x1, y0, y1) { const o = canvasFrom(null, x1 - x0, y1 - y0); o.getContext('2d').drawImage(c, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); return o; }
const nLet = s => (s.match(/[\u05D0-\u05EA]/g) || []).length;
// v8: Tesseract's own layout step sometimes skips or garbles a stretch of lines (a stain, fold or show-through
// in the column). Page cleanup already knows where every text line is; any run of 2+ lines with no real
// reading is read again on its own as one block, and kept when it gives more letters.
async function fillGaps(wk, cc, L, bands) {
  if (!bands || bands.length < 8) return { L, n: 0 };
  const real = L.filter(x => !x.para); if (!real.length) return { L, n: 0 };
  const counts = real.map(x => nLet(x.text)).sort((a, b) => a - b); const md = counts[counts.length >> 1];
  const good = real.filter(x => nLet(x.text) >= Math.max(3, 0.35 * md));
  const bh = bands.map(B => B[1] - B[0] + 1).sort((a, b) => a - b)[bands.length >> 1];
  const covered = B => { const cy = (B[0] + B[1]) / 2; return good.some(x => Math.abs(x.y - cy) <= 0.6 * Math.max(x.h, bh)); };
  const runs = []; let cur = [];
  for (const B of bands) { if (!covered(B)) cur.push(B); else { if (cur.length >= 2) runs.push(cur); cur = []; } }
  if (cur.length >= 2) runs.push(cur);
  if (!runs.length) return { L, n: 0 };
  let n = 0;
  for (const run of runs) {
    const y0 = Math.max(0, Math.round(run[0][0] - 0.5 * bh)), y1 = Math.min(cc.height, Math.round(run[run.length - 1][1] + 0.5 * bh));
    if (y1 - y0 < 2 * bh) continue;
    await wk.setParameters({ tessedit_pageseg_mode: '6' });
    let got = [];
    try { const { data } = await wk.recognize(cropRect(cc, 0, cc.width, y0, y1), {}, { blocks: true, text: false }); got = linesOf(data).filter(x => !x.para).map(x => ({ ...x, y: x.y + y0 })); }
    finally { await wk.setParameters({ tessedit_pageseg_mode: '4' }); }
    const inR = x => !x.para && x.y >= y0 && x.y <= y1;
    const oldLet = L.filter(inR).reduce((s, x) => s + nLet(x.text), 0), newLet = got.reduce((s, x) => s + nLet(x.text), 0);
    if (newLet < 1.2 * oldLet + 10) continue;
    const keep = L.filter(x => !inR(x));
    let idx = keep.findIndex(x => !x.para && x.y > y1); if (idx < 0) idx = keep.length;
    keep.splice(idx, 0, ...got); L = keep; n += run.length;
  }
  return { L, n };
}

// OCR one page. script: 'square' | 'rashi' | 'mixed'. Returns { text, changes, steps, models, perModel }
export async function enginePage(srcCanvas, { script = 'mixed', binarize = 'auto', straighten = true, clean = true, onStatus } = {}) {
  const say = t => onStatus && onStatus(t);
  say('Engine: cleaning up the page image…');
  const pp = preprocess(srcCanvas, { script, binarize, straighten, clean });
  const langs = script === 'square' ? [L_SQ] : script === 'rashi' ? [L_RASHI, L_SQ] : [L_SQ, L_RASHI];
  await loadWords().catch(() => null);
  const USE_LM = !(typeof window !== 'undefined' && window.__HOCR_NOLM);
  if (USE_LM) await loadLM().catch(e => { console.warn('word model not loaded: ' + e.message); });
  // lang -> [column lines]
  const readAll = async img => { const res = {}; const refilled = {};
  for (const lang of langs) {
    const wk = await getWorker(lang, say);
    await wk.setParameters({ tessedit_pageseg_mode: '4' });
    res[lang] = [];
    for (let i = 0; i < pp.cols.length; i++) {
      say(`Engine: reading ${pp.cols.length > 1 ? `column ${i + 1} of ${pp.cols.length} ` : ''}with the ${lang === L_SQ ? 'Hebrew' : 'Rashi'} model…`);
      const [x0, x1] = pp.cols[i]; const src = img; const cc = pp.cols.length > 1 ? cropCanvas(src, x0, x1) : src;
      const { data } = await wk.recognize(cc, {}, { blocks: true, text: false });
      const fg = await fillGaps(wk, cc, linesOf(data), pp.bands && pp.bands[i]);
      if (fg.n) refilled[lang] = (refilled[lang] || 0) + fg.n;
      res[lang].push(fg.L);
    }
  }
  return { res, refilled }; };
  let { res, refilled } = await readAll(USE_GRAY ? pp.gray : pp.bin);
  // which model fits this page better (share of real words) — that one leads, the other may replace single lines
  const pageText = l => res[l].flat().filter(x => !x.para).map(x => x.text).join(' ');
  const scores = Object.fromEntries(langs.map(l => [l, dictRatio(pageText(l))]));
  // v8: a faint or blurry scan reads better from the black & white image than from the gray one;
  // when few words come out right, read it that way too and keep whichever gives more real words.
  let faint = false;
  if (USE_GRAY && Math.max(...Object.values(scores)) < 0.88) {
    const R2 = await readAll(pp.bin);
    const pt2 = l => R2.res[l].flat().filter(x => !x.para).map(x => x.text).join(' ');
    const m1 = Math.max(...langs.map(l => dictMass(pageText(l)))), m2 = Math.max(...langs.map(l => dictMass(pt2(l))));
    if (m2 > 1.05 * m1) { res = R2.res; refilled = R2.refilled; faint = true; for (const l of langs) scores[l] = dictRatio(pageText(l)); }
  }
  const lead = langs.slice().sort((a, b) => scores[b] - scores[a])[0]; const other = langs.find(l => l !== lead);
  let swapped = 0; const colTexts = [];
  for (let i = 0; i < pp.cols.length; i++) {
    const A = res[lead][i], B = other ? res[other][i].filter(x => !x.para) : [];
    const lines = A.map(L => { if (L.para) return ''; if (!B.length) return L.text; const M = B.reduce((m, x) => Math.abs(x.y - L.y) < Math.abs(m.y - L.y) ? x : m, B[0]); if (Math.abs(M.y - L.y) > L.h * 0.6) return L.text; const s0 = dictRatio(L.text) * 100 + L.conf * 0.2, s1 = dictRatio(M.text) * 100 + M.conf * 0.2; if (s1 > s0 + 20) { swapped++; return M.text; } return L.text; });
    colTexts.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  let text = colTexts.length > 1 ? colTexts.map((t, i) => `[[טור ${i + 1}]]\n${t}`).join('\n\n') : colTexts[0];
  text = hebPunct(text);
  const pc = (USE_LM && lmCorrect(text)) || postCorrect(text);
  const extra = []; if (faint) extra.push('faint scan: read from the black & white image'); if (refilled[lead]) extra.push(`re-read ${refilled[lead]} line${refilled[lead] === 1 ? '' : 's'} the first pass missed`);
  const steps = [...pp.steps, ...extra, `${lead === L_SQ ? 'Hebrew' : 'Rashi'} model led${other ? `, ${swapped} line${swapped === 1 ? '' : 's'} taken from the ${other === L_SQ ? 'Hebrew' : 'Rashi'} model` : ''}`, `${pc.changes.length} word${pc.changes.length === 1 ? '' : 's'} corrected from the ${LMU && USE_LM ? 'Sefaria word model' : 'word list'}`];
  return { text: pc.text, raw: text, changes: pc.changes, steps, lead, scores, pp };
}

// searchable PDF page: page image + invisible text layer, made by Tesseract's own PDF writer
export async function pdfPageBytes(srcCanvas, script = 'mixed', onStatus) {
  const pp = preprocess(srcCanvas, { script, columns: false, clean: false });
  // keep the PDF light: page image at most 2000 px on the long side
  const s = Math.min(1, 2000 / Math.max(pp.w, pp.h)); const img = s < 1 ? canvasFrom(pp.gray, Math.round(pp.w * s), Math.round(pp.h * s)) : pp.gray;
  const lang = script === 'square' ? L_SQ : script === 'rashi' ? L_RASHI : L_SQ;
  const wk = await getWorker(lang, onStatus); await wk.setParameters({ tessedit_pageseg_mode: '3' });
  // a JPEG input is embedded as-is by Tesseract's PDF writer: pages stay small
  const jpg = await new Promise(r => img.toBlob(r, 'image/jpeg', 0.82));
  const { data } = await wk.recognize(jpg, { pdfTitle: 'Hebrew OCR' }, { pdf: true, text: false, blocks: false });
  return new Uint8Array(data.pdf);
}
