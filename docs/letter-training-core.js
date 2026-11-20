// Offline letter-profile data and conservative template matching. No network calls.
export const PROFILE_VERSION = 1;
export const MAX_EXAMPLES = 300;
export const MAX_SIGNATURE_LENGTH = 1100;
export const MAX_PROFILE_BYTES = 1_000_000;
export const HEBREW_LETTERS = [...'אבגדהוזחטיכךלמםנןסעפףצץקרשת'];
export const CONFUSIONS = [['ב','כ'], ['ב','ש'], ['ג','נ'], ['ד','ר'], ['ה','ח'], ['ה','ת'], ['ו','ז'], ['ו','י'], ['ח','ת'], ['כ','נ'], ['ם','ס'], ['ע','ט'], ['פ','ש'], ['ק','ה'], ['ך','ן'], ['ף','ך']];

// Merge pinholes/narrow valleys and refuse a word unless ink projection yields exactly one zone per letter.
export function projectionZones(proj, height, letterCount, inkLimit = 1) {
  const minGap = Math.max(2, Math.min(5, Math.round(height * .035))), spans = []; let x=0;
  while (x<proj.length) { while(x<proj.length && proj[x]<=inkLimit)x++; if(x>=proj.length)break; const a=x; while(x<proj.length && proj[x]>inkLimit)x++; spans.push([a,x]); }
  const zones=[];
  for(const span of spans) { const prev=zones[zones.length-1]; if(prev && span[0]-prev[1]<minGap) prev[1]=span[1]; else zones.push(span.slice()); }
  if(zones.length!==letterCount)return null;
  const widths=zones.map(([a,z])=>z-a).sort((a,b)=>a-b), med=widths[Math.floor(widths.length/2)];
  if(!med || zones.some(([a,z])=>z-a<Math.max(2,med*.18)||z-a>med*3.2))return null;
  return zones;
}
const LETTER_SET = new Set(HEBREW_LETTERS);
const validLabel = x => typeof x === 'string' && [...x].length === 1 && LETTER_SET.has(x);
const safeName = x => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= 80;

export function byteLength(s) { return new TextEncoder().encode(s).length; }
export function blankProfile(name, printId = '') {
  if (!safeName(name)) throw new Error('Profile name must be 1–80 characters.');
  if (typeof printId !== 'string' || printId.length > 120) throw new Error('Print description is too long.');
  return { format: 'hebrew-ocr-letter-profile', version: PROFILE_VERSION, name: name.trim(), printId: printId.trim(), createdAt: new Date().toISOString(), examples: [] };
}

// Accept only the explicitly versioned, bounded JSON schema. Unknown fields are discarded.
export function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.format !== 'hebrew-ocr-letter-profile' || input.version !== PROFILE_VERSION) throw new Error('Unsupported or invalid profile format/version.');
  if (!safeName(input.name) || typeof input.printId !== 'string' || input.printId.length > 120 || !Array.isArray(input.examples) || input.examples.length > MAX_EXAMPLES) throw new Error('Profile fields exceed the supported limits.');
  const examples = input.examples.map(e => {
    if (!e || typeof e !== 'object' || !validLabel(e.label) || !validLabel(e.ocr) || typeof e.signature !== 'string' || e.signature.length < 20 || e.signature.length > MAX_SIGNATURE_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.signature)) throw new Error('A profile example is malformed.');
    if (typeof e.model !== 'string' || !['heb4', 'heb_rashi7'].includes(e.model) || typeof e.confidence !== 'number' || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 100) throw new Error('A profile example has invalid recognition metadata.');
    // 24×32 binary signature = 768 bytes. Check decoded length, not merely its encoded shape.
    let decoded; try { decoded = atob(e.signature); } catch { throw new Error('A profile signature is not valid base64.'); }
    if (decoded.length !== 768 || [...decoded].some(c => c.charCodeAt(0) > 1)) throw new Error('A profile signature has an invalid bitmap.');
    const ink = [...decoded].reduce((n, c) => n + c.charCodeAt(0), 0);
    if (ink < 3 || ink > 650) throw new Error('A profile signature is blank or nearly full.');
    return { label: e.label, ocr: e.ocr, signature: e.signature, model: e.model, confidence: e.confidence };
  });
  const p = { format: 'hebrew-ocr-letter-profile', version: PROFILE_VERSION, name: input.name.trim(), printId: input.printId.trim(), createdAt: typeof input.createdAt === 'string' && input.createdAt.length < 40 ? input.createdAt : new Date().toISOString(), examples };
  if (byteLength(JSON.stringify(p)) > MAX_PROFILE_BYTES) throw new Error('Profile is larger than the 1 MB safety limit.');
  return p;
}

function decode(signature) { const s = atob(signature); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function distance(a, b) { let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++; return diff / a.length; }

// Needs at least 3 separately confirmed prototypes per label; uses the median of up to 5 nearest
// samples per class. A suggestion is emitted only for a very close, clearly separated match.
export function matchSignature(signature, profile, { minExamples = 3, maxDistance = 0.10, minMargin = 0.12, model = null } = {}) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return null;
  let probe; try { probe = decode(signature); } catch { return null; }
  if (probe.length !== 768 || [...probe].some(c => c > 1)) return null;
  const byLabel = new Map();
  for (const e of profile.examples || []) { if (!validLabel(e.label) || e.signature.length > MAX_SIGNATURE_LENGTH || (model && e.model !== model)) continue; let bits; try { bits = decode(e.signature); } catch { continue; } if (bits.length !== 768) continue; const list = byLabel.get(e.label) || []; list.push(distance(probe, bits)); byLabel.set(e.label, list); }
  const ranked = [...byLabel].filter(([, ds]) => ds.length >= minExamples).map(([label, ds]) => {
    ds.sort((a,b) => a-b); const near = ds.slice(0, 5); const med = near[Math.floor(near.length / 2)]; return { label, distance: med, examples: ds.length };
  }).sort((a,b) => a.distance-b.distance);
  // A single represented class cannot safely distinguish that glyph from every untrained class.
  if (ranked.length < 2 || ranked[0].distance > maxDistance) return null;
  const margin = ranked.length > 1 ? ranked[1].distance - ranked[0].distance : 1;
  if (margin < minMargin) return null;
  return { label: ranked[0].label, distance: ranked[0].distance, margin, examples: ranked[0].examples };
}

export function applySuggestions(word, candidates, profile) {
  const letters = [...word];
  if (letters.length !== candidates.length) return { text: word, suggestions: [], reason: 'segmentation-count-mismatch' };
  const suggestions = [];
  candidates.forEach((c, i) => {
    const m = matchSignature(c.signature, profile, { model: c.model || null });
    if (m && validLabel(letters[i]) && m.label !== letters[i]) {
      suggestions.push({ index: i, from: letters[i], to: m.label, distance: m.distance, margin: m.margin });
      letters[i] = m.label;
    }
  });
  return { text: letters.join(''), suggestions };
}
