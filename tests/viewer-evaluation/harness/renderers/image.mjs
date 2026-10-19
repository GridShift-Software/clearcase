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
  try { await img.decode(); } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: String(e.message ?? e) }; }
  return { ok: true, img, ms: Math.round(performance.now() - t0), w: img.naturalWidth, h: img.naturalHeight };
}

function sample(img, points) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return Object.fromEntries(points.map(([name, x, y]) => [name, [...g.getImageData(Math.floor(x * (cv.width - 1)), Math.floor(y * (cv.height - 1)), 1, 1).data]]));
}

async function open(descriptor, bytes, extras, target) {
  const s = sniff(bytes);
  const I = (state.image = { sniffed: s.mime, native: null, pages: 1, page: 1, zoom: 1, rotate: 0 });
  if (s.kind === 'active-text') throw new RenderError('active-content-refused', `content is ${s.mime}, not an image; it was not rendered`);
  if (s.kind !== 'image') throw new RenderError('not-an-image', `content sniffed as ${s.mime}`);
  const pages = extras.filter((x) => x.descriptor.rendition?.page).sort((a, b) => a.descriptor.rendition.page - b.descriptor.rendition.page);
  if (['image/tiff', 'image/heic'].includes(s.mime)) {
    const n = await decode(bytes, s.mime);
    I.native = { ok: n.ok, ms: n.ms, error: n.error ?? null };
    if (!pages.length) throw new RenderError('prepared-rendition-required', `${s.mime} has no native decoder here (native decode ${n.ok ? 'succeeded' : 'failed'}); a prepared rendition is required`);
  }
  const frames = typeof ImageDecoder === 'function' && (await ImageDecoder.isTypeSupported(s.mime).catch(() => false))
    ? await (async () => { const d = new ImageDecoder({ data: bytes, type: s.mime }); await d.tracks.ready; return d.tracks.selectedTrack?.frameCount ?? null; })().catch(() => null) : null;
  I.frames = frames;
  const sources = pages.length ? pages.map((p) => ({ bytes: p.bytes, mime: sniff(p.bytes).mime, label: `Prepared page image ${p.descriptor.rendition.page} (rendition v${p.descriptor.rendition.version ?? 1})` })) : [{ bytes, mime: s.mime, label: descriptor.name }];
  I.pages = sources.length;
  const wrap = el('div', { class: 'img-wrap', tabindex: '0', role: 'region', 'aria-label': 'Image' });
  const pageStatus = el('span', { id: 'page-status', 'aria-live': 'polite' });
  const bar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Image controls' },
    sources.length > 1 ? el('button', { type: 'button', id: 'prev', onclick: () => show(I.page - 1) }, 'Previous page') : null,
    sources.length > 1 ? el('button', { type: 'button', id: 'next', onclick: () => show(I.page + 1) }, 'Next page') : null,
    el('button', { type: 'button', id: 'fit', onclick: () => setZoom('fit') }, 'Fit'),
    el('button', { type: 'button', id: 'actual', onclick: () => setZoom(1) }, 'Actual size'),
    el('button', { type: 'button', id: 'zoom-out', 'aria-label': 'Zoom out', onclick: () => setZoom(I.zoom / 1.25) }, '−'),
    el('button', { type: 'button', id: 'zoom-in', 'aria-label': 'Zoom in', onclick: () => setZoom(I.zoom * 1.25) }, '+'),
    el('button', { type: 'button', id: 'rotate', onclick: () => { I.rotate = (I.rotate + 90) % 360; apply(); } }, 'Rotate'),
    pageStatus);
  app.append(bar, wrap);
  let img;
  async function show(n) {
    if (!Number.isInteger(n) || n < 1 || n > sources.length) return false;
    const src = sources[n - 1];
    const d = await decode(src.bytes, src.mime);
    if (!d.ok) throw new RenderError('decode-failed', `${src.mime} did not decode: ${d.error}`);
    img = d.img;
    img.alt = src.label;
    I.page = n; I.w = d.w; I.h = d.h; I.decodeMs = d.ms;
    I.samples = sample(img, [['topCenter', 0.5, 0.02], ['bottomCenter', 0.5, 0.98], ['leftCenter', 0.02, 0.5], ['rightCenter', 0.98, 0.5]]);
    wrap.replaceChildren(img);
    pageStatus.textContent = sources.length > 1 ? `Page ${n} of ${sources.length}` : `${d.w} × ${d.h} px`;
    setZoom('fit');
    return true;
  }
  function setZoom(z) {
    I.zoom = z === 'fit' ? Math.min(1, (wrap.clientWidth - 16) / I.w) : Math.min(8, Math.max(0.05, z));
    apply();
  }
  function apply() { if (!img) return; img.style.width = `${I.w * I.zoom}px`; img.style.transform = I.rotate ? `rotate(${I.rotate}deg)` : ''; publish(); }
  document.addEventListener('keydown', (e) => { const k = { '+': () => setZoom(I.zoom * 1.25), '=': () => setZoom(I.zoom * 1.25), '-': () => setZoom(I.zoom / 1.25), 0: () => setZoom('fit'), r: () => { I.rotate = (I.rotate + 90) % 360; apply(); }, PageDown: () => show(I.page + 1), PageUp: () => show(I.page - 1) }[e.key]; if (k) { e.preventDefault(); k(); } });
  await show(1);
  return {
    async navigate(t) {
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (t.kind === 'rendition-page' && pages.length) {
        if (t.version !== (pages[0].descriptor.rendition.version ?? 1)) return fail('stale-rendition', `cited rendition v${t.version}`, true);
        if (!(await show(t.page).catch(() => false))) return fail('invalid-target', `prepared page ${t.page} does not exist (1-${sources.length})`, true);
        return okRes(`Prepared page image ${t.page} of ${sources.length}`);
      }
      if (t.kind === 'original-page' && pages.length) {
        if (!Number.isInteger(t.page) || t.page < 1 || t.page > sources.length) return fail('invalid-target', `original page ${t.page} does not exist (1-${sources.length})`, true);
        await show(t.page);
        return okRes(`Original page ${t.page}, shown as its prepared page image`);
      }
      return fail('unsupported-target', `target kind ${t.kind} does not apply to an image`, true);
    },
  };
}
