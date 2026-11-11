// Hebrew OCR (trained models only) — page logic. No AI, no API key: every page is read in this browser
// by Tesseract with our fine-tuned Hebrew (heb4) and Rashi-script (heb_rashi7) models. The only network
// requests are for this site's own files.
import { applyOptions, allText, buildDocx, parseRange } from './core.js?v=12';
import { enginePage, pdfPageBytes, canvasFrom } from './engine.js?v=12';

const $ = s => document.querySelector(s);
const LS = { settings: 'hocr.settings' };
const MAX_SIDE = 3072;

// ---------------- settings ----------------
const settings = Object.assign({ lines: 'keep', nikud: 'keep', font: 'David', script: 'mixed', straighten: true, clean: true, binarize: 'auto' }, safeJSON(localStorage.getItem(LS.settings)));
if (!['mixed', 'rashi', 'square'].includes(settings.script)) settings.script = 'mixed';
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { localStorage.setItem(LS.settings, JSON.stringify(settings)); }
const SCRIPT_HINT = {
  mixed: 'Auto: each page is read with both models and the one that fits it better leads, line by line. Best for a Gemara page with Rashi and Tosafos.',
  rashi: 'Rashi: the page is printed in Rashi script (כתב רש״י). Uses our heb_rashi7 model first.',
  square: 'Square: regular square letters (מרובע) only. Uses our Hebrew heb4 model.'
};
function showScript() {
  document.querySelectorAll('#scriptSeg button').forEach(b => { const on = b.dataset.v === settings.script; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('#scriptHint').textContent = SCRIPT_HINT[settings.script];
}
document.querySelectorAll('#scriptSeg button').forEach(b => b.onclick = () => { settings.script = b.dataset.v; saveSettings(); showScript(); });
{ const el = $('#binarizeSel'); el.value = settings.binarize; el.onchange = () => { settings.binarize = el.value; saveSettings(); }; }
{ const st = $('#straightenChk'); st.checked = settings.straighten !== false; st.onchange = () => { settings.straighten = st.checked; saveSettings(); }; }
{ const cl = $('#cleanChk'); cl.checked = settings.clean !== false; cl.onchange = () => { settings.clean = cl.checked; saveSettings(); }; }
$('#linesSel').value = settings.lines; $('#nikudSel').value = settings.nikud; $('#fontSel').value = settings.font;
$('#fontSel').onchange = e => { settings.font = e.target.value; saveSettings(); };
for (const id of ['#linesSel', '#nikudSel']) $(id).onchange = () => {
  settings.lines = $('#linesSel').value; settings.nikud = $('#nikudSel').value; saveSettings(); refreshTexts();
};

// ---------------- pages ----------------
let pages = []; let seq = 0;
const thumbs = $('#thumbs');
function addPage(p) { p.id = ++seq; p.status = 'new'; pages.push(p); renderThumbs(); updateRunBtn(); }
function renderThumbs() {
  thumbs.innerHTML = '';
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'thumb';
    const st = { done: ['✓', 'done'], err: ['!', 'err'], run: ['…', 'run'] }[p.status];
    d.innerHTML = `<img alt="">${st ? `<span class="st ${st[1]}">${st[0]}</span>` : ''}<button class="x" title="Remove">×</button><div class="cap"></div>`;
    d.querySelector('.cap').textContent = `${i + 1}. ${p.label}`;
    if (p.thumbUrl) d.querySelector('img').src = p.thumbUrl;
    d.querySelector('.x').onclick = () => { pages = pages.filter(x => x !== p); renderThumbs(); renderResults(); updateRunBtn(); };
    thumbs.appendChild(d);
  });
}
function updateRunBtn() {
  const todo = pages.filter(p => p.status !== 'done').length;
  $('#btnRun').disabled = running || !todo;
  $('#btnRun').textContent = !todo && pages.length ? 'All pages read ✓' : todo && pages.some(p => p.status === 'done') ? `Read ${todo} remaining page${todo > 1 ? 's' : ''}` : `Start OCR${pages.length ? ` (${pages.length} page${pages.length > 1 ? 's' : ''})` : ''}`;
  $('#btnRetryFailed').classList.toggle('hidden', running || !pages.some(p => p.status === 'err'));
  if (!running) {
    if (!pages.length) status('Add photos or a PDF to start.');
  }
}

function canvasToBlob(c, q = 0.9) { return new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
async function imageToJpeg(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(blob); }); }
  const w = bmp.width, h = bmp.height, s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return canvasToBlob(c);
}
let heicLoading;
function loadHeic() {
  return heicLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/heic2any-heic2any.min.js'; s.onload = () => res(window.heic2any); s.onerror = rej; document.head.appendChild(s); });
}
const isHeic = f => /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type);
const isPdf = f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name);

let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) { pdfjs = await import('./vendor/pdfjs-dist-pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs-dist-pdf.worker.min.mjs', import.meta.url).href; }
  return pdfjs;
}
async function renderPdfPage(doc, n, target) {
  const page = await doc.getPage(n); const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(target / Math.max(v1.width, v1.height), 6);
  const v = page.getViewport({ scale }); const c = document.createElement('canvas');
  c.width = Math.round(v.width); c.height = Math.round(v.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: v }).promise; page.cleanup();
  return canvasToBlob(c, target > 1000 ? 0.9 : 0.7);
}

const fileQueue = []; let pdfPending = null; let busyAdding = false;
async function handleFiles(list) {
  fileQueue.push(...list); if (busyAdding) return; busyAdding = true;
  try {
    while (fileQueue.length) {
      const f = fileQueue.shift();
      try {
        if (isPdf(f)) { await askPdf(f); }
        else {
          status(`Loading ${f.name}…`);
          let blob = f;
          if (isHeic(f)) { const h = await loadHeic(); blob = await h({ blob: f, toType: 'image/jpeg', quality: 0.92 }); if (Array.isArray(blob)) blob = blob[0]; }
          const jpg = await imageToJpeg(blob); const url = URL.createObjectURL(jpg);
          addPage({ label: f.name, blob: jpg, url, thumbUrl: url });
        }
      } catch (e) { console.error(e); status(`Could not open ${f.name}: ${e.message || e}`, 'err'); }
    }
  } finally { busyAdding = false; updateRunBtn(); if (pages.length && !running) status(`${pages.length} page${pages.length > 1 ? 's' : ''} ready. Press Start OCR.`); }
}
async function askPdf(f) {
  status(`Opening PDF ${f.name}…`);
  const lib = await loadPdfjs(); const doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
  if (doc.numPages === 1) return addPdfPages(f, doc, [1]);
  $('#pdfName').textContent = f.name; $('#pdfCount').textContent = doc.numPages; $('#pdfRange').value = 'all'; $('#pdfBox').classList.remove('hidden');
  status(`Choose which pages of ${f.name} to read (e.g. 1-20 or 3, 5, 9-12).`);
  await new Promise(res => { pdfPending = { f, doc, res }; });
}
$('#btnPdfAdd').onclick = async () => {
  if (!pdfPending) return; const { f, doc, res } = pdfPending; pdfPending = null; $('#pdfBox').classList.add('hidden');
  const nums = parseRange($('#pdfRange').value, doc.numPages);
  if (!nums.length) status('No valid pages in that range.', 'err'); else await addPdfPages(f, doc, nums);
  res();
};
$('#btnPdfCancel').onclick = () => { if (!pdfPending) return; const { res } = pdfPending; pdfPending = null; $('#pdfBox').classList.add('hidden'); res(); };
async function addPdfPages(f, doc, nums) {
  const base = f.name.replace(/\.pdf$/i, '');
  const added = nums.map(n => { const p = { label: `${base} p.${n}`, pdf: doc, pdfPage: n }; addPage(p); return p; });
  for (let i = 0; i < added.length; i++) { // thumbnails, small and quick
    status(`Preparing PDF pages… ${i + 1}/${added.length}`);
    try { const b = await renderPdfPage(doc, added[i].pdfPage, 260); added[i].thumbUrl = URL.createObjectURL(b); } catch (e) { console.warn(e); }
    if (i % 6 === 5 || i === added.length - 1) renderThumbs();
  }
}
async function pageJpeg(p) {
  if (!p.blob && p.pdf) { p.blob = await renderPdfPage(p.pdf, p.pdfPage, 2800); p.url = URL.createObjectURL(p.blob); }
  return p.blob;
}

const drop = $('#drop');
$('#fileInput').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
$('#camInput').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handleFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
document.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) handleFiles(fs); });

// ---------------- OCR ----------------
let running = false, stopFlag = false;
function status(t, cls = '') { const s = $('#status'); s.textContent = t; s.className = 'msg ' + cls; }
function setBar() { const n = pages.length || 1; $('#bar').style.width = (100 * pages.filter(p => p.status === 'done').length / n) + '%'; }

async function pageCanvas(p) {
  const blob = await pageJpeg(p); let bmp;
  try { bmp = await createImageBitmap(blob); } catch { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(blob); }); }
  return canvasFrom(bmp, bmp.width, bmp.height);
}
async function ocrPage(p, idx) {
  p.status = 'run'; p.error = ''; p.notes = []; p.changes = []; renderThumbs();
  try {
    const r = await enginePage(await pageCanvas(p), { script: settings.script, binarize: settings.binarize, straighten: settings.straighten, clean: settings.clean !== false,
      onStatus: t => status(`Page ${idx + 1} of ${pages.length}: ${t}`) });
    p.text = r.text; p.model = 'engine'; p.status = 'done'; p.edited = false; p.notes = r.steps; p.changes = r.changes.map(c => ({ ...c, why: 'word list' }));
    p.raw = r.raw; p.lead = r.lead;
  } catch (e) { console.error(e); p.status = 'err'; p.error = 'Could not read this page: ' + (e.message || e); }
}

async function run(onlyFailed = false) {
  if (running) return; running = true; stopFlag = false;
  $('#btnStop').classList.remove('hidden'); updateRunBtn();
  $('#resultsCard').classList.remove('hidden');
  const todo = pages.filter(p => onlyFailed ? p.status === 'err' : p.status !== 'done');
  for (const p of todo) {
    if (stopFlag) break;
    await ocrPage(p, pages.indexOf(p)); renderThumbs(); renderResults(); setBar();
  }
  running = false; $('#btnStop').classList.add('hidden');
  const done = pages.filter(p => p.status === 'done').length, err = pages.filter(p => p.status === 'err');
  if (stopFlag) status(`Paused. ${done} of ${pages.length} pages done.`, 'warn');
  else status(`Done: ${done} of ${pages.length} pages read${err.length ? `, ${err.length} failed (press Retry failed pages)` : ''}.`, err.length ? 'warn' : 'ok');
  updateRunBtn(); setBar();
}
$('#btnRun').onclick = () => run(false);
$('#btnRetryFailed').onclick = () => run(true);
$('#btnStop').onclick = () => { stopFlag = true; status('Pausing after this page…', 'warn'); };
$('#btnClear').onclick = () => { if (running) return; if (pages.length && !confirm('Remove all pages and text?')) return; pages = []; renderThumbs(); renderResults(); setBar(); updateRunBtn(); $('#resultsCard').classList.add('hidden'); };
window.addEventListener('beforeunload', e => { if (pages.some(p => p.status === 'done')) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- results ----------------
const opts = () => ({ lines: settings.lines, nikud: settings.nikud });
function renderResults() {
  const box = $('#pages'); box.innerHTML = '';
  const shown = pages.filter(p => p.status === 'done' || p.status === 'err');
  $('#resultsCard').classList.toggle('hidden', !shown.length && !running);
  pages.forEach((p, i) => {
    if (p.status !== 'done' && p.status !== 'err' && !(p.status === 'run' && p.text)) return;
    const d = document.createElement('div'); d.className = 'page';
    d.innerHTML = `<div class="page-h"><b></b><span class="row wrap-row"><span class="tag"></span>
      <button class="ghost small cp">Copy</button><button class="ghost small rt">Read again</button></span></div>
      <div class="imgbox"><img alt="Page image" loading="lazy"></div><div class="tx"></div>`;
    d.querySelector('b').textContent = `Page ${i + 1} — ${p.label}`;
    d.querySelector('.tag').textContent = p.status === 'done' ? 'read with ' + (p.lead && /rashi/.test(p.lead) ? 'the Rashi model' : p.lead ? 'the Hebrew model' : 'our trained models') : p.status === 'run' ? 'reading…' : 'failed';
    const img = d.querySelector('img'); img.src = p.url || p.thumbUrl || ''; img.onclick = () => { $('#zoomImg').src = p.url || p.thumbUrl; $('#zoom').showModal(); };
    const tx = d.querySelector('.tx');
    if (p.status === 'done' || p.status === 'run') {
      const ta = document.createElement('textarea'); ta.className = 'out'; ta.dir = 'rtl'; ta.lang = 'he'; ta.spellcheck = false;
      ta.value = p.shown = p.edited ? p.shown : applyOptions(p.text, opts());
      ta.oninput = () => { p.shown = ta.value; p.edited = true; };
      tx.appendChild(ta);
      d.querySelector('.cp').onclick = e => copy(ta.value, e.target);
      if ((p.notes && p.notes.length) || (p.changes && p.changes.length)) {
        const det = document.createElement('details'); det.className = 'fixes';
        const ch = p.changes || [];
        det.innerHTML = `<summary>What was done${ch.length ? ` · ${ch.length} word${ch.length > 1 ? 's' : ''} fixed` : ''}</summary><ul></ul>`;
        const ul = det.querySelector('ul');
        (p.notes || []).forEach(n => { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); });
        ch.slice(0, 200).forEach(c => { const li = document.createElement('li'); li.className = 'chg'; li.innerHTML = '<bdi dir="rtl"></bdi> → <bdi dir="rtl"></bdi> <span class="muted"></span>'; const b = li.querySelectorAll('bdi'); b[0].textContent = c.from; b[1].textContent = c.to; li.querySelector('span').textContent = '(' + (c.why || '') + ')'; ul.appendChild(li); });
        tx.appendChild(det);
      }
    } else {
      tx.innerHTML = '<div class="err-box"></div>'; tx.firstChild.textContent = '⚠ ' + (p.error || 'Failed');
      d.querySelector('.cp').classList.add('hidden');
    }
    d.querySelector('.rt').onclick = async () => { if (running) return; p.status = 'new'; p.edited = false; running = true; stopFlag = false; const r = await ocrPage(p, i); running = false; renderThumbs(); renderResults(); setBar(); updateRunBtn(); if (p.status === 'done') status(`Page ${i + 1} read again.`, 'ok'); else status(p.error, 'err'); };
    box.appendChild(d);
  });
}
function refreshTexts() {
  if (pages.some(p => p.edited) && !confirm('Changing this will replace your manual corrections with the original text. Continue?')) {
    $('#linesSel').value = settings.lines; return; }
  pages.forEach(p => { p.edited = false; }); renderResults();
}
function exportPages() { return pages.filter(p => p.status === 'done').map(p => ({ label: p.label, text: p.edited ? p.shown : applyOptions(p.text, opts()) })); }
async function copy(t, btn) {
  try { await navigator.clipboard.writeText(t); } catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  if (btn) { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = o, 1500); }
}
function download(data, name, type) { const b = new Blob([data], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('#btnCopyAll').onclick = e => copy(allText(exportPages(), {}), e.target);
$('#btnTxt').onclick = () => download('\ufeff' + allText(exportPages(), {}), `hebrew-ocr-${stamp()}.txt`, 'text/plain;charset=utf-8');
$('#btnDocx').onclick = () => download(buildDocx(exportPages(), {}, settings.font), `hebrew-ocr-${stamp()}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
$('#zoomClose').onclick = () => $('#zoom').close();
let pdfLibLoading;
function loadPdfLib() { return pdfLibLoading ||= new Promise((res, rej) => { if (window.PDFLib) return res(window.PDFLib); const s = document.createElement('script'); s.src = 'vendor/pdf-lib.min.js'; s.onload = () => res(window.PDFLib); s.onerror = rej; document.head.appendChild(s); }); }
$('#btnPdf').onclick = async e => {
  const done = pages.filter(p => p.status === 'done'); if (!done.length || running) return;
  const btn = e.target; btn.disabled = true; running = true;
  try {
    const { PDFDocument } = await loadPdfLib(); const out = await PDFDocument.create();
    for (let i = 0; i < done.length; i++) {
      status(`Making the searchable PDF: page ${i + 1} of ${done.length}…`);
      const bytes = await pdfPageBytes(await pageCanvas(done[i]), settings.script, t => status(t));
      const one = await PDFDocument.load(bytes); const cp = await out.copyPages(one, one.getPageIndices()); cp.forEach(pg => out.addPage(pg));
    }
    download(await out.save(), `hebrew-ocr-${stamp()}.pdf`, 'application/pdf');
    status(`Searchable PDF ready (${done.length} page${done.length > 1 ? 's' : ''}). Its hidden text layer comes from our trained models.`, 'ok');
  } catch (err) { console.error(err); status('Could not make the PDF: ' + (err.message || err), 'err'); }
  finally { btn.disabled = false; running = false; updateRunBtn(); }
};

// test hook (used by the automated checks; harmless)
window.__hocr = { pages: () => pages, handleFiles, settings };
showScript(); updateRunBtn();
