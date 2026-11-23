// Coordinates refer to the original, upright page and are independent of preview scale.
const kinds = {
  auto: { name: 'Page script', label: 'אזור' },
  gemara: { name: 'Gemara', label: 'גמרא', script: 'square' },
  rashi: { name: 'Rashi', label: 'רש״י', script: 'rashi' },
  tosafos: { name: 'Tosafos', label: 'תוספות', script: 'rashi' }
};

export function regionScript(box, pageScript) {
  return kinds[box.kind].script || pageScript;
}

export function regionHeading(box, index) {
  return '[[' + kinds[box.kind].label + ' ' + (index + 1) + ']]';
}

export function regionRect(a, b) {
  const clamp = v => Math.max(0, Math.min(1, v));
  return { left: clamp(Math.min(a.x, b.x)), top: clamp(Math.min(a.y, b.y)),
    right: clamp(Math.max(a.x, b.x)), bottom: clamp(Math.max(a.y, b.y)) };
}

export function cropRegion(source, box) {
  const x = Math.floor(box.left * source.width), y = Math.floor(box.top * source.height);
  const w = Math.ceil(box.right * source.width) - x, h = Math.ceil(box.bottom * source.height) - y;
  const canvas = document.createElement('canvas');
  // Leave a white border for letters that sit against the edge of a tight selection.
  const pad = 10;
  canvas.width = w + 2 * pad;
  canvas.height = h + 2 * pad;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, x, y, w, h, pad, pad, w, h);
  return canvas;
}

export async function editRegions(page, previewUrl) {
  const $ = id => document.getElementById(id);
  const dialog = $('regionDialog'), stage = $('regionStage'), image = $('regionImage');
  const layer = $('regionBoxes'), order = $('regionOrder'), coords = $('regionCoords');
  const regions = (page.regions || []).map(r => ({ ...r }));
  let drag = null, saved = null;

  function overlay(rect, number) {
    const box = document.createElement('div');
    box.className = 'region-box';
    Object.assign(box.style, { left: rect.left * 100 + '%', top: rect.top * 100 + '%',
      width: (rect.right - rect.left) * 100 + '%', height: (rect.bottom - rect.top) * 100 + '%' });
    if (number) {
      const badge = document.createElement('b'); badge.textContent = number; box.append(badge);
    }
    layer.append(box);
    return box;
  }

  function render() {
    layer.replaceChildren(); order.replaceChildren();
    regions.forEach((r, i) => {
      overlay(r, i + 1);
      const li = document.createElement('li'); li.append(kinds[r.kind].name);
      function action(text, label, disabled, change) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'ghost small'; btn.textContent = text;
        btn.setAttribute('aria-label', label + ' region ' + (i + 1));
        btn.disabled = disabled; btn.onclick = () => { change(); render(); }; li.append(btn);
      }
      action('↑', 'Move up', i === 0, () => { [regions[i - 1], regions[i]] = [r, regions[i - 1]]; });
      action('↓', 'Move down', i === regions.length - 1, () => { [regions[i + 1], regions[i]] = [r, regions[i + 1]]; });
      action('Remove', 'Remove', false, () => regions.splice(i, 1));
      order.append(li);
    });
  }

  function add(rect) {
    if ((rect.right - rect.left) * image.naturalWidth < 8 || (rect.bottom - rect.top) * image.naturalHeight < 8) {
      $('regionMsg').textContent = 'Select a larger box around the text.'; return;
    }
    regions.push({ ...rect, kind: $('regionType').value });
    $('regionMsg').textContent = 'Added region ' + regions.length + '.'; render();
  }

  function point(e) {
    const r = image.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  image.src = previewUrl;
  await image.decode();
  $('regionPage').textContent = page.label; $('regionMsg').textContent = '';
  $('regionType').value = 'auto'; coords.reset(); render();
  stage.onpointerdown = e => {
    if (!e.isPrimary || e.button !== 0) return;
    const start = point(e);
    stage.setPointerCapture(e.pointerId);
    drag = { start, id: e.pointerId, preview: overlay(regionRect(start, start)) };
  };
  stage.onpointermove = e => {
    if (drag?.id !== e.pointerId) return;
    drag.preview.remove(); drag.preview = overlay(regionRect(drag.start, point(e)));
  };
  stage.onpointerup = e => {
    if (drag?.id !== e.pointerId) return;
    const rect = regionRect(drag.start, point(e)); drag.preview.remove(); drag = null; add(rect);
  };
  stage.onlostpointercapture = () => { drag?.preview.remove(); drag = null; };
  coords.onsubmit = e => {
    e.preventDefault();
    const data = new FormData(coords);
    const v = key => Number(data.get(key)) / 100;
    if (v('left') >= v('right') || v('top') >= v('bottom')) {
      $('regionMsg').textContent = 'Right must exceed left, and bottom must exceed top.'; return;
    }
    add({ left: v('left'), top: v('top'), right: v('right'), bottom: v('bottom') });
  };
  $('regionSave').onclick = () => { saved = regions; dialog.close(); };
  $('regionCancel').onclick = () => dialog.close();
  dialog.showModal();
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  stage.onpointerdown = stage.onpointermove = stage.onpointerup = stage.onlostpointercapture = null;
  coords.onsubmit = $('regionSave').onclick = $('regionCancel').onclick = null;
  image.removeAttribute('src'); layer.replaceChildren(); order.replaceChildren();
  return saved;
}
