import { getWorker, preprocess, canvasFrom } from './engine.js?v=14';
import { blankProfile, validateProfile, applySuggestions, HEBREW_LETTERS, CONFUSIONS, projectionZones, MAX_EXAMPLES, MAX_PROFILE_BYTES, byteLength } from './letter-training-core.js?v=1';
const $ = s => document.querySelector(s), STORAGE = 'hocr.letterProfiles.v1', HEB = /[\u05D0-\u05EA]/g;
let image = null, imageUrl = '', candidates = [], words = [], profiles = [], selectedId = '';
const say = (t, err = false) => { $('#status').textContent = t; $('#status').className = 'msg' + (err ? ' err' : ''); };
const pmsg = (t, err = false) => { $('#profileMsg').textContent = t; $('#profileMsg').className = err ? 'msg err' : 'muted small'; };
function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function readProfiles() {
  profiles = [];
  try {
    const raw = localStorage.getItem(STORAGE); if (!raw) return;
    const list = JSON.parse(raw); if (!Array.isArray(list) || list.length > 15) throw Error('invalid list');
    profiles = list.map(x => ({ id: String(x.id || uid()).slice(0, 80), profile: validateProfile(x.profile) }));
  } catch (e) { localStorage.removeItem(STORAGE); pmsg('Stored profiles were invalid and have been cleared. Import a valid exported JSON profile to restore one.', true); }
}
function writeProfiles() {
  const json = JSON.stringify(profiles);
  if (byteLength(json) > 4_000_000) throw new Error('Local profile storage reached its 4 MB limit. Export a backup and remove a profile.');
  localStorage.setItem(STORAGE, json);
}
function activeProfile() { return profiles.find(x => x.id === selectedId)?.profile || null; }
function renderProfiles() {
  const s = $('#profiles'); s.replaceChildren(); const empty = new Option('No profile selected', ''); s.add(empty);
  for (const x of profiles) s.add(new Option(`${x.profile.name} (${x.profile.examples.length})`, x.id));
  if (profiles.some(x => x.id === selectedId)) s.value = selectedId; else { selectedId = ''; s.value = ''; }
  $('#delete').disabled = !selectedId; $('#export').disabled = !selectedId;
  updateShownText(); renderCandidates();
}
$('#profiles').onchange = e => { selectedId = e.target.value; const p = activeProfile(); if (p) { $('#profileName').value = p.name; $('#printId').value = p.printId; } $('#delete').disabled = !p; $('#export').disabled = !p; updateShownText(); renderCandidates(); };

function trimLabel(s) { return [...(s || '').matchAll(HEB)].map(m => m[0]).join(''); }
function otsu(data) { const h = new Uint32Array(256); let sum = 0; for (const v of data) { h[v]++; sum += v; } let wb = 0, sb = 0, best = -1, t = 128; for (let i = 0; i < 256; i++) { wb += h[i]; if (!wb) continue; const wf = data.length - wb; if (!wf) break; sb += i * h[i]; const d = sb / wb - (sum - sb) / wf, score = wb * wf * d * d; if (score > best) { best = score; t = i; } } return t; }
function normalizeCanvas(c) {
  const W = 24, H = 32, pad = 3, src = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height), gray = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (src.data[j] * 299 + src.data[j + 1] * 587 + src.data[j + 2] * 114) / 1000;
  const threshold = otsu(gray);
  const scale = Math.min((W - 2 * pad) / c.width, (H - 2 * pad) / c.height); const w = Math.max(1, c.width * scale), h = Math.max(1, c.height * scale);
  const small = document.createElement('canvas'); small.width = W; small.height = H;
  const sg = small.getContext('2d'); sg.fillStyle = '#fff'; sg.fillRect(0, 0, W, H); sg.drawImage(c, (W - w) / 2, (H - h) / 2, w, h);
  const dat = sg.getImageData(0, 0, W, H).data, bits = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < bits.length; i++, j += 4) bits[i] = ((dat[j] * 299 + dat[j + 1] * 587 + dat[j + 2] * 114) / 1000) <= threshold ? 1 : 0;
  const binary = btoa(String.fromCharCode(...bits)); small.width = small.height = 0; return binary;
}

// Conservative horizontal-projection segmentation. Never invent equal-width character boxes:
// emit only when white gutters give exactly one component per recognized Hebrew letter.
export function splitWordIntoGlyphs(gray, x0, x1, y0, y1, letterCount) {
  const xA = Math.max(0, Math.floor(x0)), xB = Math.min(gray.width, Math.ceil(x1)), yA = Math.max(0, Math.floor(y0)), yB = Math.min(gray.height, Math.ceil(y1));
  const w = xB - xA, h = yB - yA;
  if (!Number.isInteger(letterCount) || letterCount < 1 || w < letterCount * 3 || h < 5 || w * h > 2_000_000) return null;
  const data = gray.getContext('2d', { willReadFrequently: true }).getImageData(xA, yA, w, h).data, vals = new Uint8Array(w * h), proj = new Uint32Array(w);
  for (let i = 0, j = 0; i < vals.length; i++, j += 4) vals[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
  const t = otsu(vals), inkLimit = Math.max(1, Math.round(h * .005));
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (vals[y * w + x] <= t) proj[x]++;
  // Multiple near-empty columns are required. One-pixel pinholes do not split a glyph.
  const zones=projectionZones(proj,h,letterCount,inkLimit);
  if (!zones) return null;
  const out = [];
  for (const [a,z] of zones) {
    const margin = Math.max(1, Math.round(h * .04)), top = Math.max(0, yA - margin), bottom = Math.min(gray.height, yB + margin);
    const left = Math.max(0, xA + a - margin), right = Math.min(gray.width, xA + z + margin);
    const c = canvasFrom(null, right-left, bottom-top); c.getContext('2d').drawImage(gray, left, top, right-left, bottom-top, 0, 0, right-left, bottom-top);
    out.push({ canvas: c, x0: left, x1: right, y0: top, y1: bottom });
  }
  return out;
}
function renderImage(blob) {
  return new Promise((resolve,reject) => { const im = new Image(), url = URL.createObjectURL(blob); im.onload = () => { URL.revokeObjectURL(url); if (im.naturalWidth * im.naturalHeight > 50_000_000) { reject(new Error('Image exceeds the 50 megapixel safety limit.')); return; } const scale = Math.min(1, 2800 / Math.max(im.naturalWidth, im.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.naturalWidth * scale)); c.height = Math.max(1, Math.round(im.naturalHeight * scale)); c.getContext('2d').drawImage(im,0,0,c.width,c.height); resolve(c); }; im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image.')); }; im.src = url; });
}
$('#imageFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!['image/png','image/jpeg','image/webp'].includes(f.type)) { say('Choose a JPG, PNG or WEBP image.', true); return; } if (f.size > 30_000_000) { say('Image exceeds the 30 MB local processing limit.', true); return; } renderImage(f).then(c => { image = c; if(imageUrl) URL.revokeObjectURL(imageUrl); c.toBlob(b=>{imageUrl=URL.createObjectURL(b);$('#pagePreview').src=imageUrl;$('#pagePreview').classList.remove('hidden');},'image/jpeg',0.9); $('#read').disabled = false; say(`Loaded ${f.name} (${c.width} × ${c.height}). Ready to read locally.`); }).catch(err => say(err.message, true)); };
$('#read').onclick = async () => {
  if (!image) return; $('#read').disabled = true; candidates = []; words = []; say('Preparing the image locally…');
  const script = $('#script').value, model = script === 'rashi' ? 'heb_rashi7' : 'heb4';
  let pp;
  try {
    pp = preprocess(image, { script, clean: false, straighten: true, columns: true }); const wk = await getWorker(model, say); await wk.setParameters({ tessedit_pageseg_mode: '4' });
    for (let colIndex=0; colIndex<pp.cols.length; colIndex++) { const [cx0,cx1]=pp.cols[colIndex];
      const col = pp.cols.length > 1 ? canvasFrom(pp.gray, cx1-cx0, pp.h) : pp.gray;
      if (pp.cols.length > 1) { const ctx=col.getContext('2d'); ctx.clearRect(0,0,col.width,col.height); ctx.drawImage(pp.gray,cx0,0,cx1-cx0,pp.h,0,0,cx1-cx0,pp.h); }
      const { data } = await wk.recognize(col, {}, { blocks: true, text: false });
      for (const b of data.blocks || []) for (const para of b.paragraphs || []) for (const line of para.lines || []) for (const word of line.words || []) {
        const token = word.text || '', letters = trimLabel(token), conf = Number.isFinite(word.confidence) ? Math.max(0,Math.min(100,word.confidence)) : 0;
        if (!token.trim()) continue;
        const lineKey = `${colIndex}:${Math.round(line.bbox?.y0||0)}`;
        if (!letters || letters.length > 30 || candidates.length + letters.length > MAX_EXAMPLES) { words.push({token,letters:[],conf,entries:[],lineKey}); continue; }
        const bb = word.bbox || {}; const ox = pp.cols.length > 1 ? cx0 : 0;
        const segs = splitWordIntoGlyphs(pp.gray, (bb.x0||0)+ox, (bb.x1||0)+ox, bb.y0||0, bb.y1||0, [...letters].length);
        if (!segs) { words.push({token,letters:[...letters],conf,entries:[],lineKey}); continue; }
        const entries = [];
        // Tesseract's Hebrew token is in logical order (right to left); reverse visual zones to pair them.
        const visual = [...segs].reverse();
        for (let i=0;i<letters.length;i++) {
          const s=visual[i], glyph=s.canvas; let sig;
          try { sig=normalizeCanvas(glyph); } finally { glyph.width=glyph.height=0; }
          const c={ id:uid(), ocr:letters[i], signature:sig, conf, model, preview:null, confirmed:false, label:letters[i], confusion:false, wordId:'' };
          c.preview = await new Promise(r => { const pc=canvasFrom(pp.gray,s.x1-s.x0,s.y1-s.y0); pc.getContext('2d').drawImage(pp.gray,s.x0,s.y0,s.x1-s.x0,s.y1-s.y0,0,0,pc.width,pc.height); pc.toBlob(b=>{const u=URL.createObjectURL(b); r(u); setTimeout(()=>URL.revokeObjectURL(u),300000);},'image/png'); pc.width=pc.height=0; });
          entries.push(c);
        }
        const id=uid(); entries.forEach(c=>c.wordId=id);
        words.push({id,token,letters:[...letters],conf,entries,lineY:(line.bbox?.y0||0),lineKey}); candidates.push(...entries);
      }
      if (col !== pp.gray) col.width=col.height=0;
    }
    const keep = new Set(candidates.map(c=>c.wordId)); words = words.filter(w=>!w.id || keep.has(w.id));
    say(`Read complete. Found ${candidates.length} letter crops in ${words.length} words with exact-count whitespace segmentation.${candidates.length >= MAX_EXAMPLES ? ' Review limit reached; reload a smaller crop to inspect more.' : ''} Skipped words with ambiguous segmentation.`, candidates.length ? false : true);
    populateFilter(); updateShownText(); renderCandidates();
  } catch(e) { console.error(e); say(`Could not read this page locally: ${e.message || e}`,true); }
  finally { $('#read').disabled = !image; if (pp?.gray) { pp.gray.width=pp.gray.height=0; } if (pp?.bin) { pp.bin.width=pp.bin.height=0; } }
};
function confusion(letter) { return CONFUSIONS.some(pair=>pair.includes(letter)); }
function populateFilter() { const s=$('#filter'), old=s.value; s.replaceChildren(new Option('All letters','all')); for(const l of HEBREW_LETTERS) if(candidates.some(c=>c.ocr===l)) s.add(new Option(l,l)); s.value=[...s.options].some(o=>o.value===old)?old:'all'; }
$('#filter').onchange=()=>renderCandidates();
function renderCandidates() {
  const root=$('#crops'); root.replaceChildren(); const f=$('#filter').value; const list=candidates.filter(c=>f==='all'||c.ocr===f).sort((a,b)=>(Number(b.conf<65)-Number(a.conf<65))||(Number(confusion(b.ocr))-Number(confusion(a.ocr)))||a.conf-b.conf);
  $('#count').textContent=`${list.length} crops shown · ${candidates.filter(c=>c.confirmed).length} confirmed examples in this session`;
  $('#empty').classList.toggle('hidden',!!candidates.length);
  const grouped=new Map(); for(const c of list) { const a=grouped.get(c.ocr)||[]; a.push(c); grouped.set(c.ocr,a); }
  for(const [letter,items] of grouped) {
    const section=document.createElement('section'); section.className='letter-group'; const h=document.createElement('h3'); h.innerHTML='Predicted <bdi lang="he" dir="rtl"></bdi> · '+items.length+' crop'+(items.length===1?'':'s'); h.querySelector('bdi').textContent=letter; section.append(h);
    const grid=document.createElement('div'); grid.className='crop-grid';
    for(const c of items) {
      const card=document.createElement('article'); card.className='crop-card'+(c.confirmed?' confirmed':''); const img=document.createElement('img'); img.alt=`Crop, OCR predicted ${c.ocr}`; img.src=c.preview; card.append(img);
      const meta=document.createElement('div'); meta.className='crop-meta'; meta.textContent=`word confidence ${Math.round(c.conf)}% · not letter confidence${confusion(c.ocr)?' · look-alike priority':''}`; card.append(meta);
      const row=document.createElement('div'); row.className='crop-label'; const inp=document.createElement('input'); inp.value=c.label; inp.setAttribute('aria-label','Verified Hebrew letter label'); inp.maxLength=1; inp.dir='rtl'; inp.oninput=()=>{const l=trimLabel(inp.value); c.label=[...l][0]||'';}; row.append(inp);
      const btn=document.createElement('button'); btn.className='ghost small'; btn.textContent=c.confirmed?'Confirmed ✓':'Confirm sample'; btn.onclick=()=>confirmSample(c,inp,btn,card); row.append(btn); card.append(row);
      if(c.match) { const note=document.createElement('div'); note.className='notice'; note.textContent=`Profile match suggests ${c.match.to} for ${c.ocr} (distance ${c.match.distance.toFixed(3)}, margin ${c.match.margin.toFixed(3)}). Review the page; not auto-applied.`; card.append(note); }
      grid.append(card);
    }
    section.append(grid); root.append(section);
  }
  updateShownText();
}
function confirmSample(c,inp,btn,card) {
  const p=activeProfile(); if(!p) { pmsg('Create or select a profile before confirming examples.',true); return; }
  const label=trimLabel(inp.value); if([...label].length!==1||!HEBREW_LETTERS.includes(label)) { pmsg('Enter exactly one Hebrew letter as the verified label.',true); return; }
  if(p.examples.length>=MAX_EXAMPLES) { pmsg(`Profile is at the ${MAX_EXAMPLES}-example cap. Export or create a new profile.`,true); return; }
  p.examples.push({label,ocr:c.ocr,signature:c.signature,model:c.model,confidence:c.conf});
  try { writeProfiles(); c.confirmed=true; c.label=label; btn.textContent='Confirmed ✓'; card.classList.add('confirmed'); pmsg(`Confirmed ${label}. Examples are saved only on this device.`); renderProfiles(); }
  catch(e) { p.examples.pop(); pmsg(e.message,true); }
}
function updateShownText() {
  const p=activeProfile(), updates=[]; const out=words.map(w=>{
    const sug=p&&w.entries.length?applySuggestions(w.letters,w.entries,p):{text:w.letters.join(''),suggestions:[]};
    for(const s of sug.suggestions){const c=w.entries[s.index];c.match={...s};updates.push(s);}
    if(!sug.suggestions.length) w.entries.forEach(c=>{delete c.match;});
    let idx=0; return {text:w.token.replace(/[\u05D0-\u05EA]/g,ch=>{const n=sug.suggestions.find(x=>x.index===idx)?.to; idx++; return n||ch;}),lineKey:w.lineKey};
  });
  $('#recognized').value=out.map((item,i)=>`${i?(out[i-1].lineKey===item.lineKey?' ':'\n'):''}${item.text}`).join('');
  $('#suggestions').textContent=updates.length?`${updates.length} conservative local template suggestion${updates.length===1?'':'s'} available. Text above shows suggestions, clearly not verified. Profile examples do not train or alter Tesseract.`:'No high-confidence profile match. Original recognized letters are unchanged.';
}
$('#recognized').oninput=()=>{};
$('#save').onclick=()=>{
  const name=$('#profileName').value.trim(), printId=$('#printId').value.trim();
  try {
    let p,id=selectedId?selectedId:uid();
    if(selectedId) { const old=profiles.find(x=>x.id===selectedId)?.profile; if(!old) throw Error('Selected profile is missing.'); p=validateProfile({...old,name,printId}); }
    else { if(profiles.length>=15) throw Error('Maximum of 15 local profiles. Export and delete an unused profile first.'); p=blankProfile(name,printId); }
    const oldIndex=profiles.findIndex(x=>x.id===id), next={id,profile:p}; if(oldIndex<0) profiles.push(next); else profiles[oldIndex]=next;
    writeProfiles(); selectedId=id; renderProfiles(); pmsg(`Saved “${p.name}” on this device (${p.examples.length} confirmed samples).`);
  } catch(e) { pmsg(e.message,true); }
};
$('#delete').onclick=()=>{ if(!selectedId)return; const n=activeProfile()?.name||'this profile'; if(!confirm(`Delete “${n}” from this device?`))return; profiles=profiles.filter(x=>x.id!==selectedId); selectedId=''; try{writeProfiles();renderProfiles();pmsg('Profile deleted from this device.');}catch(e){pmsg(e.message,true);} };
$('#export').onclick=()=>{const p=activeProfile();if(!p)return;const data=JSON.stringify(validateProfile(p),null,2);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'application/json'}));a.download=(p.name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'')||'letter-profile')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
$('#import').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{if(f.size>MAX_PROFILE_BYTES)throw Error('Profile file exceeds the 1 MB import limit.');const p=validateProfile(JSON.parse(await f.text()));if(profiles.length>=15)throw Error('Maximum of 15 local profiles. Delete one before importing.');profiles.push({id:uid(),profile:p});writeProfiles();selectedId=profiles.at(-1).id;renderProfiles();pmsg(`Imported “${p.name}” and saved it only on this device.`);}catch(err){pmsg(`Import rejected: ${err.message||err}`,true);}};
$('#downloadText').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+$('#recognized').value],{type:'text/plain;charset=utf-8'}));a.download='letter-profile-suggestions.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
readProfiles(); renderProfiles();
