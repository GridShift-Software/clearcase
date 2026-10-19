// Native <img> reader with fit/actual/zoom/rotate controls. Bytes are sniffed before decoding: SVG/HTML or a format
// with no native decoder is refused (TIFF/HEIC still get a native decode attempt, recorded as evidence), and a
// prepared rendition page set is shown page by page instead.
import { app, boot, el, fail, okRes, publish, state, RenderError } from './common.mjs';
import { sniff } from '../shared/formats.mjs';

boot('image', { open });

async function decode(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const img = el('img', { alt: '', src: url });
  const t0 = performance.now();
  let api = 'decode()';
  try { await img.decode(); } catch (e) {
    // Chrome's decode() rejects a 100 MP PNG that still loads, paints and decodes to a bitmap; a broken image fails both
    try {
      if (!img.complete) await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      if (!img.naturalWidth) throw e;
      (await createImageBitmap(new Blob([bytes], { type: mime }))).close();
      api = 'load + createImageBitmap (decode() rejected)';
    } catch { return { ok: false, ms: Math.round(performance.now() - t0), error: String(e.message ?? e) }; }
  }
  return { ok: true, img, api, ms: Math.round(performance.now() - t0), w: img.naturalWidth, h: img.naturalHeight };
}

function sample(img, points) {
  // one source pixel per point into a 1x1 canvas, so a 100 MP image never needs a full-size canvas
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  return Object.fromEntries(points.map(([name, x, y]) => {
    g.clearRect(0, 0, 1, 1);
    g.drawImage(img, Math.floor(x * (img.naturalWidth - 1)), Math.floor(y * (img.naturalHeight - 1)), 1, 1, 0, 0, 1, 1);
    return [name, [...g.getImageData(0, 0, 1, 1).data]];
  }));
}

async function open(descriptor, bytes, extras, target) {
  const s = sniff(bytes);
  const I = (state.image = { sniffed: s.mime, native: null, pages: 1, page: 1, zoom: 1, rotate: 0 });
  if (s.kind === 'active-text') throw new RenderError('active-content-refused', `content is ${s.mime}, not an image; it was not rendered`);
  if (s.kind !== 'image') throw new RenderError('not-an-image', `content sniffed as ${s.mime}`);
  // Prepared page images are found by the page number their own descriptor carries (rendition.page), never by position,
  // and each must be linked to this original. A page with no image is a refusal, not the next image.
  const byPage = new Map();
  for (const x of extras) {
    const page = x.descriptor.rendition?.page;
    if (x.descriptor.original?.assetId !== descriptor.assetId || !Number.isInteger(page) || page < 1) throw new RenderError('page-image-not-linked', `${x.descriptor.assetId} is not a numbered page image of ${descriptor.assetId}`);
    if (byPage.has(page)) throw new RenderError('duplicate-page-image', `two page images are numbered ${page}`);
    byPage.set(page, x);
  }
  const hasPages = byPage.size > 0;
  const total = hasPages ? (descriptor.pages ?? Math.max(...byPage.keys())) : 1;
  const available = [...byPage.keys()].sort((x, y) => x - y);
  if (['image/tiff', 'image/heic'].includes(s.mime)) {
    const n = await decode(bytes, s.mime);
    I.native = { ok: n.ok, ms: n.ms, error: n.error ?? null };
    if (!hasPages) throw new RenderError('prepared-rendition-required', `${s.mime} has no native decoder here (native decode ${n.ok ? 'succeeded' : 'failed'}); a prepared rendition is required`);
  }
  const frames = typeof ImageDecoder === 'function' && (await ImageDecoder.isTypeSupported(s.mime).catch(() => false))
    ? await (async () => { const d = new ImageDecoder({ data: bytes, type: s.mime }); await d.tracks.ready; return d.tracks.selectedTrack?.frameCount ?? null; })().catch(() => null) : null;
  I.frames = frames;
  const source = (n) => { if (!hasPages) return n === 1 ? { bytes, mime: s.mime, label: descriptor.name } : null; const p = byPage.get(n); return p ? { bytes: p.bytes, mime: sniff(p.bytes).mime, assetId: p.descriptor.assetId, label: `Prepared page image ${n} (rendition v${p.descriptor.rendition.version ?? 1})` } : null; };
  I.pages = hasPages ? available.length : 1;
  I.total = total;
  const wrap = el('div', { class: 'img-wrap', tabindex: '0', role: 'region', 'aria-label': 'Image' });
  const pageStatus = el('span', { id: 'page-status', 'aria-live': 'polite' });
  const bar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Image controls' },
    available.length > 1 ? el('button', { type: 'button', id: 'prev', onclick: () => step(-1) }, 'Previous page') : null,
    available.length > 1 ? el('button', { type: 'button', id: 'next', onclick: () => step(1) }, 'Next page') : null,
    el('button', { type: 'button', id: 'fit', onclick: () => setZoom('fit') }, 'Fit'),
    el('button', { type: 'button', id: 'actual', onclick: () => setZoom(1) }, 'Actual size'),
    el('button', { type: 'button', id: 'zoom-out', 'aria-label': 'Zoom out', onclick: () => setZoom(I.zoom / 1.25) }, '−'),
    el('button', { type: 'button', id: 'zoom-in', 'aria-label': 'Zoom in', onclick: () => setZoom(I.zoom * 1.25) }, '+'),
    el('button', { type: 'button', id: 'rotate', onclick: () => { I.rotate = (I.rotate + 90) % 360; apply(); } }, 'Rotate'),
    pageStatus);
  app.append(bar, wrap);
  let img;
  const step = (dir) => { const i = available.indexOf(I.page) + dir; return available[i] === undefined ? false : show(available[i]); };
  async function show(n) {
    const src = source(n);
    if (!src) return false;
    const d = await decode(src.bytes, src.mime);
    if (!d.ok) throw new RenderError('decode-failed', `${src.mime} did not decode: ${d.error}`);
    img = d.img;
    img.alt = src.label;
    I.page = n; I.shownAsset = src.assetId ?? descriptor.assetId; I.w = d.w; I.h = d.h; I.decodeMs = d.ms; I.decodeApi = d.api;
    I.samples = sample(img, [['topCenter', 0.5, 0.02], ['bottomCenter', 0.5, 0.98], ['leftCenter', 0.02, 0.5], ['rightCenter', 0.98, 0.5]]);
    wrap.replaceChildren(img);
    pageStatus.textContent = hasPages && total > 1 ? `Page ${n} of ${total}` : `${d.w} × ${d.h} px`;
    setZoom('fit');
    return true;
  }
  function setZoom(z) {
    I.zoom = z === 'fit' ? Math.min(1, (wrap.clientWidth - 16) / I.w) : Math.min(8, Math.max(0.05, z));
    apply();
  }
  function apply() { if (!img) return; img.style.width = `${I.w * I.zoom}px`; img.style.transform = I.rotate ? `rotate(${I.rotate}deg)` : ''; publish(); }
  document.addEventListener('keydown', (e) => { const k = { '+': () => setZoom(I.zoom * 1.25), '=': () => setZoom(I.zoom * 1.25), '-': () => setZoom(I.zoom / 1.25), 0: () => setZoom('fit'), r: () => { I.rotate = (I.rotate + 90) % 360; apply(); }, PageDown: () => step(1), PageUp: () => step(-1) }[e.key]; if (k) { e.preventDefault(); k(); } });
  await show(hasPages ? available[0] : 1);
  return {
    async navigate(t) {
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (hasPages && (t.kind === 'rendition-page' || t.kind === 'original-page')) {
        const version = byPage.values().next().value.descriptor.rendition.version ?? 1;
        if (t.kind === 'rendition-page' && t.version !== version) return fail('stale-rendition', `cited rendition v${t.version}`, true);
        if (!Number.isInteger(t.page) || t.page < 1 || t.page > total) return fail('invalid-target', `${t.kind === 'original-page' ? 'original' : 'prepared'} page ${t.page} does not exist (1-${total})`, true);
        if (!byPage.has(t.page)) return t.kind === 'original-page' ? fail('unmapped-original-location', `original page ${t.page} has no prepared page image`, true) : fail('invalid-target', `prepared page ${t.page} does not exist in the page-image set`, true);
        await show(t.page);
        return okRes(t.kind === 'original-page' ? `Original page ${t.page}, shown as its prepared page image` : `Prepared page image ${t.page} of ${total}`);
      }
      return fail('unsupported-target', `target kind ${t.kind} does not apply to an image`, true);
    },
  };
}
