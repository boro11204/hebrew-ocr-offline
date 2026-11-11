// v13 (Nov 2026): new-section detector — finds where a new teshuva / numbered section starts in the middle
// of a page, from the PAGE LAYOUT ONLY (no outside text is looked up), so the text can break there.
// Signs it reads, per column:
//   • an extra vertical gap (a blank line) above the line, or a short line just before it;
//   • the line opens with a Hebrew number (רנ״ט, שב, ק״א …) — in this kind of print the teshuva number;
//   • the number stands apart: a wider gap after it than between the other words;
//   • or the line is a short centered title (סימן …, שאלה, תשובה) after a gap.
// It never changes a letter: the result only adds line breaks (a blank line, then the heading on its own line).
const HEB = /[\u05D0-\u05EA]/g;
const VAL = { 'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,'י':10,'כ':20,'ל':30,'מ':40,'נ':50,'ס':60,'ע':70,'פ':80,'צ':90,'ק':100,'ר':200,'ש':300,'ת':400 };
const MARK = /[״׳"']/;
const COMMON = new Set(['שלא','שלו','שמו','תלה','שבו','קרא','רק','שם','תם','קם','רב','רע','רצה','שבע','תקע']);
const TITLE = /^(סימן|סימנים|שאלה|תשובה|פרק|שאלות|קונטרס|הקדמה|חלק)$/;
const lettersOf = s => (s.match(HEB) || []).join('');
const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
// value of a Hebrew number written in letters (hundreds, then tens, then units; טו/טז), else null
export function hebNumber(tok) {
  const w = tok.replace(/^[:.,;·()[\]]+|[:.,;·()[\]]+$/g, '');
  if (/[^\u05D0-\u05EA״׳"']/.test(w)) return null;
  const l = w.replace(/[״׳"']/g, '');
  if (l.length < 1 || l.length > 4 || [...l].some(c => !VAL[c])) return null;
  let i = 0, n = 0;
  while (i < l.length && VAL[l[i]] >= 100) { if (i && VAL[l[i]] > VAL[l[i - 1]]) return null; n += VAL[l[i]]; i++; }
  const r = l.slice(i);
  if (r === 'טו') return n + 15; if (r === 'טז') return n + 16; if (r === 'יה' || r === 'יו') return null;
  let j = 0;
  if (j < r.length && VAL[r[j]] >= 10 && VAL[r[j]] < 100) { n += VAL[r[j]]; j++; }
  if (j < r.length && VAL[r[j]] < 10) { n += VAL[r[j]]; j++; }
  return j === r.length ? n : null;
}
// a first word that can be a section number: with geresh/gershayim (ר״מ, ש׳), or 2–4 letters starting with
// a hundreds letter (רנט, שב); a bare single letter (א, ב …) counts only when it stands apart from the text.
function numKind(tok) {
  const n = hebNumber(tok); if (n === null) return null;
  const l = lettersOf(tok);
  if (MARK.test(tok)) { if (l.length === 1 && /[׳']$/.test(tok.replace(/[:.,]+$/, '')) && 'רהקמ'.includes(l)) return null; return 'mark'; }
  if (l.length >= 2 && 'קרשת'.includes(l[0]) && !COMMON.has(l)) return 'plain';
  if (l.length === 1) return 'single';
  return null;
}
// lines: one column, in reading order, as made by the engine: { para:true } markers or
//   { y, h, text, x0, x1, words:[{ text, x0, x1, y0, y1 }] } (pixel boxes of the column image)
// returns Map(index -> { kind, split, noBlank }) — kind 'number' | 'title'; split = put the number on its own line
export function findSectionStarts(lines, opts = {}) {
  const out = new Map();
  const R = [];
  lines.forEach((L, i) => { if (!L.para && L.words && L.words.length && L.x1 > L.x0) R.push({ L, i }); });
  if (R.length < 6) return out;
  const wh = []; R.forEach(({ L }) => L.words.forEach(w => { if (lettersOf(w.text).length >= 2) wh.push(w.y1 - w.y0); }));
  const hs = med(wh) || med(R.map(({ L }) => L.h)) || 1;
  const right = pct(R.map(({ L }) => L.x1), 0.75), left = pct(R.map(({ L }) => L.x0), 0.25), Wc = Math.max(1, right - left);
  const dys = []; for (let k = 1; k < R.length; k++) { const d = R[k].L.y - R[k - 1].L.y; if (d > 0 && d < 4 * hs) dys.push(d); }
  const pitch = med(dys) || 1.6 * hs;
  const VG = opts.vgap || 1.5, GR = opts.gapRatio || 2.0, PW = opts.prevShort || 0.6, GS = opts.shapeGap || 2.0, GT = opts.topGap || 2.0;
  for (let k = 0; k < R.length; k++) {
    const { L, i } = R[k];
    const ws = L.words.slice().sort((a, b) => b.x1 - a.x1);               // right to left
    const first = ws[0].text.trim();
    const prev = k ? R[k - 1].L : null;
    const vgap = prev ? (L.y - prev.y) / pitch : 0;
    const prevw = prev ? (prev.x1 - prev.x0) / Wc : 1;
    const gaps = []; for (let j = 1; j < ws.length; j++) gaps.push(ws[j - 1].x0 - ws[j].x1);
    const mg = Math.max(1, med(gaps.slice(1)));
    const g0r = gaps.length ? gaps[0] / mg : 0;
    const w = (L.x1 - L.x0) / Wc, cen = ((L.x0 + L.x1) / 2 - (left + right) / 2) / Wc;
    const lh = med(ws.filter(x => lettersOf(x.text).length >= 2).map(x => x.y1 - x.y0)) || L.h;
    const gapAbove = !prev || vgap >= VG;
    // 1) numbered start (a first 'word' that is a speck or a smudge — far too small or too wide — is not a number)
    const fw = ws[0], fh = fw.y1 - fw.y0, fwd = fw.x1 - fw.x0, speck = (fh < 0.45 * hs && fwd < 0.6 * hs) || fwd > 3 * hs * Math.max(1, lettersOf(first).length);
    const kind = numKind(first), small = kind === 'mark' && hebNumber(first) < 100;
    const second = ws.length > 1 ? lettersOf(ws[1].text).length : 0;
    let ok = false;
    if (kind && ws.length >= 2 && !speck) {
      if (!prev) ok = kind !== 'single' && !small && g0r >= GT;                         // top of the column: the number must stand apart
      else if (kind === 'single' || small) ok = g0r >= GR && (vgap >= VG || prevw < PW) && w >= 0.6 && second >= 2;
      else ok = vgap >= VG || (prevw < PW && g0r >= GR);
    }
    // 1b) the same shape when the OCR misread the number: a short first word set apart, after a blank line, on a full line
    const fl = lettersOf(first).length;
    if (!ok && !kind && !speck && prev && vgap >= VG && fl >= 1 && fl <= 4 && g0r >= GS && w >= 0.6 && ws.length >= 3 && second >= 2) ok = true;
    if (ok) { const pm = k ? out.get(R[k - 1].i) : null; out.set(i, { kind: 'number', split: true, noBlank: !!(pm && pm.kind === 'title') }); continue; }
    // 2) short centered title line (סימן …, שאלה, תשובה) after a gap
    const t0 = lettersOf(first);
    if (gapAbove && ws.length <= 4 && w < 0.6 && Math.abs(cen) < 0.15 && (TITLE.test(t0) || (ws.length === 1 && kind && kind !== 'single'))) {
      out.set(i, { kind: 'title', split: false }); continue;
    }
    // (tested and left out: "larger type after a gap" — on the Prague book it caught no teshuva start and
    //  fired 43 times, all on the author's signature line at the END of a teshuva)
    void lh;
  }
  return out;
}
// Apply the breaks to finished text. lineMarks: Map(lineIndex -> {split}) on text.split('\n').
// Only line breaks are added; every other character stays exactly as it was.
export function applySectionBreaks(text, lineMarks) {
  if (!lineMarks || !lineMarks.size) return text;
  const src = text.split('\n'); const dst = [];
  src.forEach((line, i) => {
    const m = lineMarks.get(i);
    if (m && line.trim()) {
      if (!m.noBlank && dst.length && dst[dst.length - 1].trim() !== '' && !/^\[\[טור \d+\]\]$/.test(dst[dst.length - 1])) dst.push('');
      const sp = line.indexOf(' ');
      if (m.split && sp > 0 && lettersOf(line.slice(0, sp)).length <= 4 && line.slice(sp + 1).trim()) { dst.push(line.slice(0, sp)); dst.push(line.slice(sp + 1)); return; }
    }
    dst.push(line);
  });
  return dst.join('\n');
}
