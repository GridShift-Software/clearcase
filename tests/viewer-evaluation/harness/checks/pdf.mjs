import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'pdf';
const C = 'pdf.js 6.4.299';
const cur = (c) => () => c.inFrame(() => window.__r.pdf?.current ?? null);
const waitText = (c, n) => c.inFrame(async (n) => { for (let i = 0; i < 100; i++) { const t = window.__pdf.renderedText(n); if (t) return t; await new Promise((r) => setTimeout(r, 50)); } return null; }, n);

export default async function pdf(c, { full, skipLarge }) {
  let id = 'pdf/text-basic.pdf';
  await opens(c, F, id, C);
  await layout(c, F, id, C);
  if (!full) { await accepts(c, F, id, C, { kind: 'original-page', page: 2 }, 'Page 2 of 3', async () => (await waitText(c, 2))?.includes('PDF-TEXT-0002')); return; }
  const st = await c.rstate();
  c.record(F, id, C, 'page count', st.pdf.numPages === 3, 'numPages === 3', st.pdf.numPages);
  await accepts(c, F, id, C, { kind: 'original-page', page: 2 }, 'Page 2 of 3', async () => (await waitText(c, 2))?.includes('PDF-TEXT-0002'));
  await rejects(c, F, id, C, [[{ kind: 'original-page', page: 0 }, 'invalid-target'], [{ kind: 'original-page', page: 4 }, 'invalid-target'], [{ kind: 'original-page', page: 2.5 }, 'invalid-target'], [{ kind: 'rendition-page', version: 1, page: 1 }, 'not-a-rendition']], cur(c));
  await accepts(c, F, id, C, { kind: 'file' }, 'File-level reference');
  // find
  await c.frame().fill('#find', 'PDF-TEXT-0003');
  await c.frame().press('#find', 'Enter');
  await sleep(300);
  const f = await c.inFrame(() => ({ find: window.__r.pdf.find, current: window.__r.pdf.current, status: document.getElementById('find-status').textContent }));
  c.record(F, id, C, 'find locates text and moves to its page', f.current === 3 && f.find?.pages?.join() === '3', 'find(PDF-TEXT-0003) -> pages [3], current 3', f);
  // zoom
  const z0 = await c.inFrame(() => ({ s: window.__r.pdf.scale, w: document.getElementById('page-1').getBoundingClientRect().width }));
  await c.frame().click('#zoom-in');
  await sleep(300);
  const z1 = await c.inFrame(() => ({ s: window.__r.pdf.scale, w: document.getElementById('page-1').getBoundingClientRect().width }));
  c.record(F, id, C, 'zoom in enlarges the page', z1.s > z0.s && z1.w > z0.w, 'scale and page width increase after Zoom in', { z0, z1 });
  // keyboard page navigation
  await c.navigate({ kind: 'original-page', page: 1 });
  await c.frame().focus('#pages');
  await c.page.keyboard.press('PageDown');
  await sleep(150);
  const kb = await c.inFrame(() => window.__r.pdf.current);
  c.record(F, id, C, 'keyboard: PageDown moves to the next page', kb === 2, 'current === 2 after PageDown from page 1', kb);
  await keyboardRoundTrip(c, F, id, C);

  id = 'pdf/mixed-pages-labels.pdf';
  await opens(c, F, id, C);
  const labels = (await c.rstate()).pdf.labels;
  c.record(F, id, C, 'page labels exposed separately from physical pages', JSON.stringify(labels) === JSON.stringify(['i', 'ii', '1', '2', '3', '3']), "labels === ['i','ii','1','2','3','3']", labels);
  await accepts(c, F, id, C, { kind: 'page-label', label: 'ii' }, 'physical page 2');
  await rejects(c, F, id, C, [[{ kind: 'page-label', label: '3' }, 'ambiguous-label'], [{ kind: 'page-label', label: 'iv' }, 'invalid-target']], cur(c));
  for (const n of [3, 4, 5]) { await c.navigate({ kind: 'original-page', page: n }); await waitText(c, n); }
  const dims = await c.inFrame(() => [3, 4, 5].map((n) => { const r = document.getElementById(`page-${n}`).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  c.record(F, id, C, 'mixed sizes and /Rotate 90 render with their own geometry', dims[1][0] > dims[1][1] && dims[2][0] > dims[2][1] && dims[0][0] < dims[0][1], 'landscape page and rotated portrait page are wider than tall; A4 page taller than wide', dims);

  id = 'pdf/scanned-no-text.pdf';
  await opens(c, F, id, C);
  const noText = await c.inFrame(async () => (await window.__pdf.textOf(1)).trim() === '');
  c.record(F, id, C, 'image-only page detected (no text layer) so an OCR companion is required', noText, 'getTextContent(page 1) is empty', noText);
  await opens(c, F, id, `${C} + OCR companion`, { kind: 'file' }, { extra: ['pdf/scanned-no-text.ocr.txt'] });
  const ocr = await c.inFrame(() => document.getElementById('ocr')?.textContent ?? '');
  c.record(F, id, `${C} + OCR companion`, 'prepared OCR companion shown beside the page', ocr.includes('PDF-OCR-COMPANION-TOKEN'), 'details#ocr contains the companion token', ocr.slice(0, 80));

  id = 'pdf/hostile-actions.pdf';
  const e0 = c.mon.egress.length;
  await opens(c, F, id, C);
  await waitText(c, 1);
  await sleep(500);
  const h = await c.inFrame(() => ({ js: document.getElementById('js-note')?.textContent ?? null, blocked: document.querySelectorAll('[data-blocked=external]').length, anchorsWithHref: [...document.querySelectorAll('.annotationLayer a[href]')].map((a) => a.getAttribute('href')), inputs: document.querySelectorAll('.annotationLayer input, .annotationLayer textarea, .annotationLayer button').length, csp: window.__r.blocked }));
  c.record(F, id, C, 'document JavaScript detected, reported and not run', !!h.js && /not run/.test(h.js), '#js-note present and says it was not run', h.js);
  c.record(F, id, C, 'external URI link rendered inert', h.blocked >= 1 && !h.anchorsWithHref.some((x) => /^https?:|^file:|javascript:/i.test(x)), 'at least one [data-blocked=external]; no anchor with an http/file/javascript href', h);
  c.record(F, id, C, 'form widgets not interactive (renderForms off)', h.inputs === 0, 'no input/textarea/button in the annotation layer', h.inputs);
  for (const sel of ['.annotationLayer a', '.annotationLayer section']) { const n = await c.inFrame((s) => { const els = [...document.querySelectorAll(s)]; els.forEach((e) => e.click()); return els.length; }, sel); if (n) await sleep(200); }
  await sleep(300);
  c.record(F, id, C, 'clicking every link/widget causes no egress, dialog or navigation', c.egressSince(e0).length === 0 && !c.mon.dialogs.length && !c.mon.topNavigations.length, 'no new egress, dialogs or top navigations', { egress: c.egressSince(e0), dialogs: c.mon.dialogs });

  id = 'pdf/truncated.pdf';
  const tr = await c.open(id);
  const hold = c.descriptors.get(id).holds.map((x) => x.code);
  c.record(F, id, 'candidate import', 'damaged PDF is held at import even if pdf.js recovers pages', hold.includes('pdf-damaged'), "descriptor.holds includes 'pdf-damaged'", { holds: hold, pdfjs: tr.type, code: tr.code });

  id = 'pdf/encrypted-user-password.pdf';
  const enc = await c.open(id);
  c.record(F, id, C, 'password-protected PDF fails explicitly (no prompt, no partial view)', enc.type === 'error' && enc.code === 'password-required', "renderer error code 'password-required'", { type: enc.type, code: enc.code });
  c.record(F, id, 'candidate import', 'encrypted PDF held for a decrypted prepared rendition', c.descriptors.get(id).holds.some((x) => x.code === 'pdf-encrypted-needs-decrypted-rendition'), "holds include 'pdf-encrypted-needs-decrypted-rendition'", c.descriptors.get(id).holds);

  id = 'pdf/encrypted-inline-dict.pdf';
  const inl = await c.open(id);
  c.record(F, id, 'candidate import', 'inline /Encrypt<<...>> (no whitespace after the name) is still held', c.descriptors.get(id).holds.some((x) => x.code === 'pdf-encrypted-needs-decrypted-rendition'), "holds include 'pdf-encrypted-needs-decrypted-rendition'", c.descriptors.get(id).holds);
  c.record(F, id, C, 'inline-encrypted PDF fails explicitly', inl.type === 'error', 'renderer reports an error, not a view', { type: inl.type, code: inl.code });

  id = 'pdf/inherited-attributes.pdf';
  await opens(c, F, id, C);
  for (const n of [1, 2, 3]) { await c.navigate({ kind: 'original-page', page: n }); await waitText(c, n); }
  const inh = await c.inFrame(async () => Promise.all([1, 2, 3].map(async (n) => { const r = document.getElementById(`page-${n}`).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), text: await window.__pdf.textOf(n) }; })));
  c.record(F, id, C, 'attributes inherited through a two-level page tree apply (/MediaBox, /Rotate, indirect /Resources)', inh[0].h > inh[0].w && inh[1].h > inh[1].w && inh[2].w === inh[2].h, 'pages 1-2: 842x595 rotated 90 render taller than wide; page 3 overrides to a square', inh.map(({ w, h }) => [w, h]));
  c.record(F, id, C, 'a /Contents array is drawn in full and every page has its text', inh[0].text.includes('PDF-INHERIT-P1-A') && inh[0].text.includes('PDF-INHERIT-P1-B') && inh[1].text.includes('PDF-INHERIT-P2') && inh[2].text.includes('PDF-INHERIT-P3'), 'P1-A and P1-B on page 1, P2 on page 2, P3 on page 3', inh.map((x) => x.text));

  id = 'pdf/cjk-nonembedded.pdf';
  const before = c.serverLog.length;
  await opens(c, F, id, C);
  const cjk = await c.inFrame(() => window.__pdf.textOf(1));
  const cmaps = c.serverLog.slice(before).filter((l) => l.path.includes('/cmaps/'));
  c.record(F, id, C, 'non-embedded CJK text extracts through the static CMap path', cjk.includes('中文测试'), "text of page 1 includes '中文测试'", cjk);
  c.record(F, id, C, 'CMap fetches carry no credentials', cmaps.length > 0 && cmaps.every((l) => !l.authed), 'every /vendor/pdfjs/cmaps/ request arrived without the session cookie', cmaps.slice(0, 3));

  if (!skipLarge) {
    id = 'pdf/large-1000-pages.pdf';
    const r = await opens(c, F, id, C);
    const t0 = Date.now();
    await c.navigate({ kind: 'original-page', page: 1000 });
    const last = await waitText(c, 1000);
    const navMs = Date.now() - t0;
    c.record(F, id, C, '1,000-page PDF: open and jump to the last page', r.type === 'ready' && last?.includes('PDF-LARGE-1000'), 'page 1000 text layer contains PDF-LARGE-1000', { readyMs: r.ms, navMs });
    const t1 = Date.now();
    await c.frame().fill('#find', 'PDF-LARGE-0999');
    await c.frame().press('#find', 'Enter');
    await c.inFrame(async () => { for (let i = 0; i < 600; i++) { if (window.__r.pdf.find?.index >= 0) return; await new Promise((r) => setTimeout(r, 100)); } });
    const fr = await c.inFrame(() => window.__r.pdf.find);
    c.record(F, id, C, '1,000-page PDF: find across all pages', fr?.pages?.join() === '999', 'find(PDF-LARGE-0999) -> [999]', { findMs: Date.now() - t1 });
  }
}
