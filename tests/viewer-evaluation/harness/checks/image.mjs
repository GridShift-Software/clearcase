import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'image';
const C = 'native img (Chrome)';
const near = (a, b, tol = 40) => a && b.every((v, i) => Math.abs(a[i] - v) <= tol);

export default async function image(c, { full, skipLarge }) {
  let id = 'image/png-pattern.png';
  await opens(c, F, id, C);
  await layout(c, F, id, C);
  if (!full) return;
  let st = (await c.rstate()).image;
  c.record(F, id, C, 'PNG decodes with exact geometry and colours', st.w === 400 && st.h === 200 && near(st.samples.leftCenter, [255, 0, 0, 255]) && near(st.samples.rightCenter, [0, 0, 255, 255]), '400x200, left red, right blue', st);
  const z0 = st.zoom;
  await c.frame().click('#zoom-in');
  await c.frame().focus('.img-wrap');
  await c.page.keyboard.press('r');
  await sleep(100);
  st = (await c.rstate()).image;
  c.record(F, id, C, 'zoom and rotate controls (button and keyboard r)', st.zoom > z0 && st.rotate === 90, 'zoom increases; rotate === 90 after r', { z0, zoom: st.zoom, rotate: st.rotate });
  await rejects(c, F, id, C, [[{ kind: 'original-page', page: 2 }, 'unsupported-target']], async () => (await c.rstate()).image.page);
  await keyboardRoundTrip(c, F, id, C);

  id = 'image/jpeg-exif-orientation-6.jpg';
  await opens(c, F, id, C);
  st = (await c.rstate()).image;
  c.record(F, id, C, 'JPEG EXIF orientation 6 applied', st.w === 200 && st.h === 400 && near(st.samples.topCenter, [255, 0, 0, 255], 60) && near(st.samples.bottomCenter, [0, 0, 255, 255], 60), 'displayed 200x400 with red on top, blue at bottom', st);

  id = 'image/png-alpha.png';
  await opens(c, F, id, C);
  st = (await c.rstate()).image;
  c.record(F, id, C, 'PNG alpha preserved', near(st.samples.leftCenter, [0, 128, 0, 255], 10) && st.samples.rightCenter[3] === 0, 'left opaque green, right alpha 0', st.samples);

  id = 'image/gif-animated-3.gif';
  await opens(c, F, id, C);
  st = (await c.rstate()).image;
  c.record(F, id, C, 'animated GIF: all frames present', st.frames === 3, 'ImageDecoder frameCount === 3', st.frames);

  for (const [fid, mime] of [['image/webp-pattern.webp', 'webp'], ['image/avif-pattern.avif', 'avif']]) {
    const r = await opens(c, F, fid, C);
    st = (await c.rstate()).image;
    c.record(F, fid, C, `${mime.toUpperCase()} decodes`, r.type === 'ready' && st.w === 400 && near(st.samples.leftCenter, [255, 0, 0, 255], 60), '400x200, left red', st && { w: st.w, h: st.h, left: st.samples?.leftCenter });
  }

  for (const fid of ['image/tiff-multipage-g4.tif', 'image/tiff-lzw.tif', 'image/tiff-jpeg.tif', 'image/bigtiff.tif', 'image/heic-pattern.heic']) {
    const r = await c.open(fid);
    st = (await c.rstate()).image;
    c.record(F, fid, C, 'no native decoder: refused with an explicit prepared-rendition state', r.type === 'error' && r.code === 'prepared-rendition-required', "renderer error 'prepared-rendition-required' (native decode attempted and recorded)", { code: r.code, native: st?.native });
  }
  id = 'image/tiff-multipage-g4.tif';
  const pages = [1, 2, 3].map((n) => `image/tiff-multipage-g4.rendition-p${n}.png`);
  await opens(c, F, id, 'prepared page images (PNG per page)', { kind: 'original-page', page: 2 }, { extra: pages });
  st = (await c.rstate()).image;
  c.record(F, id, 'prepared page images (PNG per page)', 'every TIFF page reachable as a prepared page image', st.pages === 3 && st.page === 2, 'pages === 3; original-page 2 opens prepared page 2', { pages: st.pages, page: st.page });
  await rejects(c, F, id, 'prepared page images (PNG per page)', [[{ kind: 'original-page', page: 4 }, 'invalid-target'], [{ kind: 'rendition-page', version: 2, page: 1 }, 'stale-rendition']], async () => (await c.rstate()).image.page);
  id = 'image/heic-pattern.heic';
  await opens(c, F, id, 'prepared page image (PNG)', { kind: 'file' }, { extra: ['image/heic-pattern.rendition.png'] });

  for (const fid of ['image/svg-masquerade.png', 'image/html-masquerade.jpg']) {
    const e0 = c.mon.egress.length;
    const r0 = await c.open(fid);
    c.record(F, fid, 'protected shell', 'content that sniffs as SVG or HTML matches no reader and the shell refuses it', r0.ok === false && /family/.test(r0.error ?? ''), "descriptor family 'unknown' refused before a frame exists", { family: c.descriptors.get(fid).family, r: r0 });
    // defence in depth: force the image reader on it, as a mislabelled descriptor would
    const r = await c.open(c.alias(fid, `${fid}@labelled-image`, { family: 'image' }));
    await sleep(200);
    const st2 = await c.rstate();
    c.record(F, fid, C, 'image reader forced onto the masquerade refuses it unrendered', r.type === 'error' && r.code === 'active-content-refused' && c.egressSince(e0).length === 0 && st2 !== null && st2.blocked.length === 0, "error 'active-content-refused'; no egress; reader state readable and no CSP violations (nothing tried to load)", { code: r.code ?? r.type, blocked: st2?.blocked ?? null });
    c.record(F, fid, 'candidate import', 'masquerade held at import', c.descriptors.get(fid).holds.some((h) => h.code === 'active-content-not-accepted'), "holds include 'active-content-not-accepted'", c.descriptors.get(fid).holds.map((h) => h.code));
  }

  if (!skipLarge) for (const [fid, mp] of [['image/large-20mp.png', 20], ['image/large-100mp.png', 100]]) {
    const r = await c.open(fid, { kind: 'file' }, { timeoutMs: 60000 });
    st = (await c.rstate())?.image;
    c.record(F, fid, C, `${mp} MP image decodes (desktop Chrome; not mobile memory evidence)`, r.type === 'ready' && st.w * st.h === mp * 1e6, `ready and naturalWidth*naturalHeight === ${mp}e6`, { type: r.type, ms: r.ms, decodeMs: st?.decodeMs, decodeApi: st?.decodeApi, w: st?.w, h: st?.h, code: r.code });
  }
}
