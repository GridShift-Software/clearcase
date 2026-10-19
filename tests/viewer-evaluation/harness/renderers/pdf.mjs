// pdf.js reader (pinned pdfjs-dist), derived from the incumbent local viewer: scripting, XFA, forms and WASM off,
// external links never followed, main-thread "fake worker" (worker-src 'none'), lazy page canvases with text and
// annotation layers. Adds page/label navigation, zoom, find and the rendition/original target rules.
import { app, boot, el, fail, okRes, publish, resolvePaged, state, RenderError } from './common.mjs';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
const OPTIONS = Object.freeze({ enableScripting: false, hasJSActions: false, renderForms: false });

boot('pdf', { open });

async function open(descriptor, bytes, extras, target, options) {
  const pdfjs = await import(VENDOR + 'pdf.min.mjs');
  globalThis.pdfjsWorker = await import(VENDOR + 'pdf.worker.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: bytes, useWasm: false, enableXfa: false, useSystemFonts: false, stopAtErrors: false, isEvalSupported: false, standardFontDataUrl: VENDOR + 'standard_fonts/', cMapUrl: VENDOR + 'cmaps/', cMapPacked: true });
  task.onPassword = () => { task.destroy(); };
  let pdf;
  try { pdf = await task.promise; } catch (e) {
    throw new RenderError(e?.name === 'PasswordException' || /password/i.test(e?.message) ? 'password-required' : 'pdf-unreadable', e?.message ?? String(e));
  }
  const numPages = pdf.numPages;
  const labels = await pdf.getPageLabels().catch(() => null);
  const docJs = await pdf.getJSActions().catch(() => null);
  const docJsKeys = docJs ? Object.keys(docJs) : [];
  const fieldJs = await pdf.hasJSActions().catch(() => false);
  const P = (state.pdf = { numPages, current: 0, labels, scale: 1, jsActions: { document: docJsKeys, fields: fieldJs }, find: null, rendered: 0 });
  const companions = extras.filter((x) => x.descriptor.name.endsWith('.txt')).map((x) => new TextDecoder().decode(x.bytes));

  const status = el('span', { id: 'page-status', 'aria-live': 'polite' });
  const pageInput = el('input', { type: 'number', min: '1', max: String(numPages), 'aria-label': 'Go to page', id: 'page-input' });
  const find = el('input', { type: 'search', 'aria-label': 'Find in document', id: 'find', placeholder: 'Find' });
  const findStatus = el('span', { id: 'find-status', 'aria-live': 'polite' });
  const pagesEl = el('div', { id: 'pages', tabindex: '0', role: 'region', 'aria-label': 'Document pages' });
  const bar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'PDF controls' },
    el('button', { type: 'button', id: 'prev', onclick: () => show(P.current - 1) }, 'Previous page'),
    el('button', { type: 'button', id: 'next', onclick: () => show(P.current + 1) }, 'Next page'),
    pageInput, status,
    el('button', { type: 'button', id: 'zoom-out', 'aria-label': 'Zoom out', onclick: () => zoom(P.scale / 1.25) }, '−'),
    el('button', { type: 'button', id: 'zoom-in', 'aria-label': 'Zoom in', onclick: () => zoom(P.scale * 1.25) }, '+'),
    el('button', { type: 'button', id: 'zoom-fit', onclick: () => zoom(fitScale) }, 'Fit width'),
    find, findStatus);
  app.append(bar);
  if (docJsKeys.length || fieldJs) app.append(el('p', { class: 'notice', id: 'js-note' }, `This PDF contains JavaScript (${[...docJsKeys, ...(fieldJs ? ['form fields'] : [])].join(', ')}). It was not run.`));
  if (companions.length) app.append(el('details', { id: 'ocr' }, el('summary', {}, 'Text companion (prepared OCR)'), el('pre', { class: 'plain-body' }, companions.join('\n'))));
  app.append(pagesEl);
  pageInput.addEventListener('change', async () => { const r = await nav({ kind: 'original-page', page: Number(pageInput.value) }); if (!r.ok) status.textContent = r.detail; });

  const linkService = {
    externalLinkEnabled: false,
    eventBus: { dispatch() {}, on() {}, off() {}, _on() {}, _off() {} },
    get pagesCount() { return numPages; }, get page() { return P.current; }, set page(n) { show(n); },
    rotation: 0, isInPresentationMode: false,
    addLinkAttributes(link, url) { link.removeAttribute('href'); link.title = `External link, not followed: ${url}`; link.dataset.blocked = 'external'; },
    getDestinationHash: () => '#', getAnchorUrl: () => '#',
    async goToDestination(dest) { const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest; const ref = Array.isArray(explicit) ? explicit[0] : null; const idx = ref && typeof ref === 'object' ? await pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null; if (idx !== null) show(idx + 1); },
    goToPage(n) { show(n); },
    executeNamedAction() {}, executeSetOCGState() {}, setHash() {},
  };

  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const fitScale = Math.min(2, Math.max(0.3, (pagesEl.clientWidth - 32) / vp1.width));
  P.scale = fitScale;
  const slots = [];
  const textCache = new Map();
  const textOf = async (n) => { if (!textCache.has(n)) { const p = await pdf.getPage(n); const tc = await p.getTextContent(); textCache.set(n, tc.items.map((i) => i.str).join(' ')); } return textCache.get(n); };
  window.__pdf = { textOf, renderedText: (n) => slots[n - 1]?.div.querySelector('.textLayer')?.textContent ?? null, struct: async (n) => !!(await (await pdf.getPage(n)).getStructTree().catch(() => null)) };

  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) render(+e.target.dataset.page); }, { root: null, rootMargin: '100% 0px' });
  function layout() {
    pagesEl.replaceChildren();
    slots.length = 0;
    for (let n = 1; n <= numPages; n++) {
      const div = el('div', { class: 'page', id: `page-${n}`, 'data-page': String(n), role: 'img', 'aria-label': `Page ${n}${labels ? ` (label ${labels[n - 1]})` : ''}` });
      div.style.width = `${Math.floor(vp1.width * P.scale)}px`;
      div.style.height = `${Math.floor(vp1.height * P.scale)}px`;
      pagesEl.append(div);
      slots.push({ div, state: null });
      io.observe(div);
    }
  }
  async function render(n) {
    const s = slots[n - 1];
    if (!s || s.state) return;
    s.state = 'rendering';
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: P.scale });
    const div = s.div;
    div.style.width = `${Math.floor(vp.width)}px`;
    div.style.height = `${Math.floor(vp.height)}px`;
    div.style.setProperty('--scale-factor', String(vp.scale));
    div.style.setProperty('--user-unit', String(vp.userUnit ?? 1));
    div.style.setProperty('--total-scale-factor', String(vp.scale * (vp.userUnit ?? 1)));
    const ratio = window.devicePixelRatio || 1;
    const canvas = el('canvas');
    canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = `${Math.floor(vp.width)}px`; canvas.style.height = `${Math.floor(vp.height)}px`;
    div.append(canvas);
    await page.render({ canvas, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    const text = el('div', { class: 'textLayer' });
    div.append(text);
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render().catch(() => {});
    const annots = await page.getAnnotations({ intent: 'display' }).catch(() => []);
    if (annots.length) {
      const layer = el('div', { class: 'annotationLayer' });
      div.append(layer);
      await new pdfjs.AnnotationLayer({ div: layer, page, viewport: vp.clone({ dontFlip: true }), linkService }).render({ annotations: annots, linkService, ...OPTIONS }).catch(() => {});
    }
    s.state = 'done';
    div.dataset.rendered = '1';
    P.rendered++;
    publish();
  }
  function show(n) {
    if (!Number.isInteger(n) || n < 1 || n > numPages) return false;
    for (const s of slots) s.div.classList.remove('target');
    const s = slots[n - 1];
    s.div.classList.add('target');
    s.div.scrollIntoView({ block: 'start' });
    P.current = n;
    pageInput.value = String(n);
    status.textContent = `Page ${n} of ${numPages}${labels ? ` (label ${labels[n - 1]})` : ''}`;
    publish();
    render(n);
    return true;
  }
  function zoom(s) {
    P.scale = Math.min(4, Math.max(0.25, s));
    const keep = P.current || 1;
    layout();
    show(keep);
  }
  async function nav(t) {
    if (t?.kind === 'page-label') {
      if (!labels) return fail('invalid-target', 'this PDF has no page labels', true);
      const hits = labels.map((l, i) => (l === String(t.label) ? i + 1 : 0)).filter(Boolean);
      if (hits.length > 1) return fail('ambiguous-label', `label ${t.label} is on pages ${hits.join(', ')}`, true);
      if (!hits.length) return fail('invalid-target', `no page is labelled ${t.label}`, true);
      show(hits[0]);
      return okRes(`Page labelled ${t.label} (physical page ${hits[0]} of ${numPages})`, { page: hits[0] });
    }
    const r = resolvePaged(descriptor, t, numPages);
    if (r.ok) { show(r.page); await render(r.page); }
    return r;
  }
  find.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = find.value.trim().toLowerCase();
    if (!q) return;
    if (P.find?.query !== q) {
      const pages = [];
      for (let n = 1; n <= numPages; n++) if ((await textOf(n)).toLowerCase().includes(q)) pages.push(n);
      P.find = { query: q, pages, index: -1 };
    }
    if (!P.find.pages.length) { findStatus.textContent = 'No matches'; publish(); return; }
    P.find.index = (P.find.index + 1) % P.find.pages.length;
    show(P.find.pages[P.find.index]);
    findStatus.textContent = `Match ${P.find.index + 1} of ${P.find.pages.length} (page ${P.find.pages[P.find.index]})`;
    publish();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); find.focus(); return; }
    const k = { PageDown: () => show(P.current + 1), ArrowRight: () => show(P.current + 1), PageUp: () => show(P.current - 1), ArrowLeft: () => show(P.current - 1), Home: () => show(1), End: () => show(numPages), '+': () => zoom(P.scale * 1.25), '=': () => zoom(P.scale * 1.25), '-': () => zoom(P.scale / 1.25), '/': () => find.focus() }[e.key];
    if (k) { e.preventDefault(); k(); }
  });
  layout();
  return { navigate: nav };
}
