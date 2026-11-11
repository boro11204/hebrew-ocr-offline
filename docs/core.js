// Hebrew OCR — core logic (no DOM). Text options, Word/TXT export, page ranges. No AI, no network.
export const VERSION = '2026-11-11';

// ---------- text options ----------
const TEAMIM = /[\u0591-\u05AF\u05BD]/g;               // cantillation + meteg
const NIKUD  = /[\u05B0-\u05BC\u05C1\u05C2\u05C4\u05C5\u05C7]/g; // vowels, dagesh, shin/sin dots
export function stripNikud(s) { return s.replace(TEAMIM, '').replace(NIKUD, ''); }
export function stripTeamim(s) { return s.replace(TEAMIM, ''); }

export const isLabel = l => /^\s*\[\[.*\]\]\s*$/.test(l);

// lines: 'keep' | 'join'
export function joinLines(s) {
  const out = [];
  for (const block of s.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    let buf = [];
    const flush = () => { if (buf.length) { out.push(buf.join(' ').replace(/\s+/g, ' ').trim()); buf = []; } };
    for (const l of lines) {
      if (isLabel(l)) { flush(); out.push(l.trim()); } else if (l.trim()) buf.push(l.trim());
    }
    flush();
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function applyOptions(text, opts = {}) {
  let t = text || '';
  if (opts.nikud === 'none') t = stripNikud(t);
  else if (opts.nikud === 'noteamim') t = stripTeamim(t);
  if (opts.lines === 'join') t = joinLines(t);
  return t;
}

export function pageTitle(p, i) { return `עמוד ${i + 1}` + (p.label ? ` — ${p.label}` : ''); }

export function allText(pages, opts) {
  return pages.map((p, i) => `=== ${pageTitle(p, i)} ===\n\n` + (p.text ? applyOptions(p.text, opts) : '[לא נקרא]')).join('\n\n\n') + '\n';
}

// ---------- tiny .docx writer (zip "store", no compression) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export function zipStore(files) { // files: [{name, data: Uint8Array}]
  const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  const u16 = n => [n & 255, (n >>> 8) & 255]; const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data); const size = f.data.length;
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name]);
    chunks.push(local, f.data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
    offset += local.length + size;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...central, end]; const total = all.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total); let p = 0; for (const c of all) { out.set(c, p); p += c.length; } return out;
}

export function xmlEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }

export function buildDocx(pages, opts = {}, font = 'David') {
  const enc = new TextEncoder();
  const run = (t, { bold = false, size = 28, color = null } = {}) =>
    `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${bold ? '<w:b/><w:bCs/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:rtl/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:bidi="he-IL"/></w:rPr><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
  const para = (inner, { center = false, pageBreakBefore = false, after = 0 } = {}) =>
    `<w:p><w:pPr>${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}<w:bidi/><w:spacing w:after="${after}" w:line="276" w:lineRule="auto"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${inner}</w:p>`;
  let body = '';
  pages.forEach((p, i) => {
    body += para(run(pageTitle(p, i), { bold: true, size: 24, color: '7A5C2E' }), { center: true, pageBreakBefore: i > 0, after: 200 });
    const text = p.text ? applyOptions(p.text, opts) : '[לא נקרא]';
    for (const line of text.split('\n')) {
      if (isLabel(line)) body += para(run(line.trim().replace(/^\[\[|\]\]$/g, ''), { bold: true, size: 26 }), { after: 60 });
      else body += para(line ? run(line) : '', { after: line ? 0 : 120 });
    }
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:rtl/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="he-IL" w:bidi="he-IL"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:bidi/><w:jc w:val="both"/></w:pPr></w:style></w:styles>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(doc) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) },
    { name: 'word/styles.xml', data: enc.encode(styles) },
  ]);
}

// "1-3, 5, 8-" -> [1,2,3,5,8..max]
export function parseRange(s, max) {
  s = (s || '').trim(); if (!s || /^all$/i.test(s)) return Array.from({ length: max }, (_, i) => i + 1);
  const set = new Set();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    if (m) { let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : max; if (a > b) [a, b] = [b, a]; for (let i = Math.max(1, a); i <= Math.min(max, b); i++) set.add(i); }
    else if (/^\d+$/.test(part)) { const n = +part; if (n >= 1 && n <= max) set.add(n); }
  }
  return [...set].sort((a, b) => a - b);
}

// ---------- v3: light, deterministic clean-up of text (final letters), with a list of what changed ----------
const FIN_ = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' }; const UNFIN_ = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export function fixFinals(text) {
  const changes = [];
  const out = text.replace(/(^|[^\u05D0-\u05EA\u0591-\u05C7])([\u05D0-\u05EA\u0591-\u05C7]{2,})(?![\u05D0-\u05EA\u0591-\u05C7׳״'"])/g, (m, pre, w) => {
    const letters = [...w]; let lastIdx = -1; letters.forEach((ch, i) => { if (/[\u05D0-\u05EA]/.test(ch)) lastIdx = i; });
    const fixed = letters.map((ch, i) => i < lastIdx ? (UNFIN_[ch] || ch) : i === lastIdx ? (FIN_[ch] || ch) : ch).join('');
    if (fixed !== w) changes.push({ from: w, to: fixed, why: 'final letter' });
    return pre + fixed; });
  return { text: out, changes };
}
