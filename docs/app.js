// Hebrew OCR (trained models only) — page logic. No AI, no API key: every page is read in this browser
// by Tesseract with our fine-tuned Hebrew (heb4) and Rashi-script (heb_rashi7) models. The only network
// requests are for this site's own files.
import { applyOptions, allText, buildDocx, parseRange } from './core.js?v=13';
import { enginePage, pdfPageBytes, canvasFrom } from './engine.js?v=13';

const $ = s => document.querySelector(s);
const LS = { settings: 'hocr.settings' };
const MAX_SIDE = 3072;
const PREVIEW_SIDE = 1600; // v13: preview kept for each PDF page after OCR

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
  if (thumbObs) thumbObs.disconnect();
  thumbs.innerHTML = '';
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'thumb';
    const st = { done: ['✓', 'done'], err: ['!', 'err'], run: ['…', 'run'] }[p.status];
    d.innerHTML = `<img alt="">${st ? `<span class="st ${st[1]}">${st[0]}</span>` : ''}<button class="x" title="Remove">×</button><div class="cap"></div>`;
    d.querySelector('.cap').textContent = `${i + 1}. ${p.label}`;
    d.dataset.pid = p.id;
    if (p.thumbUrl) d.querySelector('img').src = p.thumbUrl;
    else if (p.pdf) { if (thumbObs) thumbObs.observe(d); else { thumbQ.push(p); thumbWork(); } }
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
// v13 (big PDFs): read the PDF from the file in 1 MB pieces as pages need them, instead of loading
// the whole file into memory first (a 270 MB scan used to sit in memory whole).
async function openPdf(lib, f) {
  if (f.size < 40e6 || !lib.PDFDataRangeTransport) return lib.getDocument({ data: await f.arrayBuffer() }).promise;
  class FileRange extends lib.PDFDataRangeTransport {
    requestDataRange(begin, end) { f.slice(begin, end).arrayBuffer().then(b => this.onDataRange(begin, new Uint8Array(b)), e => console.warn(e)); }
  }
  return lib.getDocument({ range: new FileRange(f.size, null), rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true }).promise;
}
async function renderPdfPage(doc, n, target) {
  const page = await doc.getPage(n); const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(target / Math.max(v1.width, v1.height), 6);
  const v = page.getViewport({ scale }); const c = document.createElement('canvas');
  c.width = Math.round(v.width); c.height = Math.round(v.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: v }).promise; page.cleanup();
  const b = await canvasToBlob(c, target > 1000 ? 0.9 : 0.7); c.width = c.height = 0; // v13: free the canvas now, not at GC
  return b;
}
// v13 (big PDFs): pdf.js keeps decoded page images in memory; let it drop them now and then
async function pdfCleanup(doc) { try { await doc.cleanup(); } catch (e) { /* busy: next time */ } }

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
  const lib = await loadPdfjs(); const doc = await openPdf(lib, f);
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
  // v13: pages are added at once; each thumbnail is drawn only when it scrolls into view (see thumbObs),
  // so "all" on a 120-page PDF no longer decodes 120 page images up front.
  const added = nums.map(n => ({ label: `${base} p.${n}`, pdf: doc, pdfPage: n, id: ++seq, status: 'new' }));
  pages.push(...added); renderThumbs(); updateRunBtn();
  status(`${added.length} page${added.length > 1 ? 's' : ''} of ${f.name} added. Press Start OCR.`);
}
const thumbQ = []; let thumbBusy = false;
async function thumbWork() {
  if (thumbBusy) return; thumbBusy = true;
  try {
    let k = 0;
    while (thumbQ.length) {
      const p = thumbQ.shift(); if (p.thumbUrl || !pages.includes(p)) continue;
      try { const b = await renderPdfPage(p.pdf, p.pdfPage, 260); p.thumbUrl = URL.createObjectURL(b); const im = thumbs.querySelector(`[data-pid="${p.id}"] img`); if (im) im.src = p.thumbUrl; } catch (e) { console.warn(e); }
      if (++k % 4 === 0) await pdfCleanup(p.pdf);
      if (running) await new Promise(r => setTimeout(r, 50));
    }
  } finally { thumbBusy = false; }
}
const thumbObs = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { const p = pages.find(x => x.id === +e.target.dataset.pid); thumbObs.unobserve(e.target); if (p && p.pdf && !p.thumbUrl && !thumbQ.includes(p)) thumbQ.push(p); }
  thumbWork();
}, { rootMargin: '300px' }) : null;
async function pageJpeg(p) {
  if (!p.blob && p.pdf) { p.blob = await renderPdfPage(p.pdf, p.pdfPage, 2800); await pdfCleanup(p.pdf); } // v13: no full-size URL kept (the box shows the thumbnail, then a preview)
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
  const c = canvasFrom(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close();
  return c;
}
// v13 (big PDFs): a PDF page's full-size image is rendered only when OCR reaches it, and freed right after;
// the page keeps a small preview for its result box. "Read again" and the searchable PDF render it again.
async function keepPreview(p, c) {
  if (!p.pdf) return;
  const s = Math.min(1, PREVIEW_SIDE / Math.max(c.width, c.height));
  const pv = canvasFrom(c, Math.round(c.width * s), Math.round(c.height * s));
  const b = await canvasToBlob(pv, 0.82); pv.width = pv.height = 0;
  if (p.url) URL.revokeObjectURL(p.url);
  p.url = URL.createObjectURL(b);
  if (!p.thumbUrl) p.thumbUrl = p.url;
}
function freeFull(p) { if (p.pdf) p.blob = null; } // the big JPEG goes; p.url is now the preview
let eta = '';
async function ocrPage(p, idx) {
  p.status = 'run'; p.error = ''; p.notes = []; p.changes = []; renderThumbs();
  let c;
  try {
    c = await pageCanvas(p); await keepPreview(p, c); freeFull(p);
    const r = await enginePage(c, { script: settings.script, binarize: settings.binarize, straighten: settings.straighten, clean: settings.clean !== false,
      onStatus: t => status(`Page ${idx + 1} of ${pages.length}: ${t}${eta}`) });
    p.text = r.text; p.model = 'engine'; p.status = 'done'; p.edited = false; p.notes = r.steps; p.changes = r.changes.map(c => ({ ...c, why: 'word list' }));
    p.raw = r.raw; p.lead = r.lead;
  } catch (e) { console.error(e); p.status = 'err'; p.error = 'Could not read this page: ' + (e.message || e); }
  finally { if (c) c.width = c.height = 0; }
}

function fmtMin(s) { return s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; }
async function run(onlyFailed = false) {
  if (running) return; running = true; stopFlag = false;
  $('#btnStop').classList.remove('hidden'); updateRunBtn();
  $('#resultsCard').classList.remove('hidden');
  const todo = pages.filter(p => onlyFailed ? p.status === 'err' : p.status !== 'done');
  const t0 = performance.now(); let n = 0; eta = '';
  for (const p of todo) {
    if (stopFlag) break;
    await ocrPage(p, pages.indexOf(p)); n++; renderThumbs(); renderResults(); setBar();
    const per = (performance.now() - t0) / 1000 / n, left = todo.length - n;
    eta = left > 0 ? ` · ${n} of ${todo.length} done, about ${fmtMin(per * left)} left (${per.toFixed(0)} s a page)` : '';
    if (left > 0 && !stopFlag) status(`Page ${n} of ${todo.length} read${eta}`);
  }
  eta = '';
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
      const pc = await pageCanvas(done[i]); freeFull(done[i]);
      const bytes = await pdfPageBytes(pc, settings.script, t => status(t)); pc.width = pc.height = 0;
      const one = await PDFDocument.load(bytes); const cp = await out.copyPages(one, one.getPageIndices()); cp.forEach(pg => out.addPage(pg));
    }
    download(await out.save(), `hebrew-ocr-${stamp()}.pdf`, 'application/pdf');
    status(`Searchable PDF ready (${done.length} page${done.length > 1 ? 's' : ''}). Its hidden text layer comes from our trained models.`, 'ok');
  } catch (err) { console.error(err); status('Could not make the PDF: ' + (err.message || err), 'err'); }
  finally { btn.disabled = false; running = false; updateRunBtn(); }
};

// test hook (used by the automated checks; harmless)
window.__hocr = { pages: () => pages, handleFiles, settings, ocrText: () => exportPages().map(p => p.text).join('\n\n') }; // ocrText: read-only copy for the Compare tool
showScript(); updateRunBtn();
