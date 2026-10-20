// docx-preview reader, evaluated against the prepared-PDF path. Defaults follow the pre-read: altChunk rendering off,
// external relationships never fetched (the CSP blocks them; the adapter also strips them before display).
import { renderAsync } from 'docx-preview';
import { app, boot, el, fail, okRes, publish, state, RenderError } from './common.mjs';
import { sniff } from '../shared/formats.mjs';

boot('word', { open });

async function open(descriptor, bytes, extras, target, options) {
  const s = sniff(bytes);
  if (s.kind !== 'zip') throw new RenderError('not-docx', `content sniffed as ${s.mime}; docx-preview reads DOCX (OOXML) only`);
  const opts = { inWrapper: true, ignoreLastRenderedPageBreak: true, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false, renderChanges: false, renderAltChunks: false, useBase64URL: true, experimental: false, ...options };
  const style = el('div', { id: 'docx-style' });
  const body = el('div', { id: 'docx', role: 'document', tabindex: '0', 'aria-label': descriptor.name });
  app.append(el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Word controls' }, el('span', { id: 'mode' }, `docx-preview (${Object.entries(opts).filter(([k, v]) => /^render(Comments|Changes|AltChunks)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(', ')})`)), style, body);
  const t0 = performance.now();
  try { await renderAsync(bytes, body, style, opts); } catch (e) { throw new RenderError('docx-render-failed', e?.message ?? String(e)); }
  // external images/links: remove the URL before it is ever displayed or requested
  let stripped = 0;
  for (const n of body.querySelectorAll('img[src^="http"], a[href]')) {
    if (n.tagName === 'IMG') { n.removeAttribute('src'); n.alt = 'External image not loaded'; stripped++; }
    else if (!n.getAttribute('href').startsWith('#')) { n.title = `External link, not followed: ${n.getAttribute('href')}`; n.removeAttribute('href'); stripped++; }
  }
  const sections = body.querySelectorAll('section.docx');
  state.word = { renderMs: Math.round(performance.now() - t0), sections: sections.length, stripped, options: opts, text: body.innerText.slice(0, 20000), iframes: body.querySelectorAll('iframe').length };
  publish();
  return {
    async navigate(t) {
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (t.kind === 'original-page' || t.kind === 'rendition-page') return fail('unmapped-original-location', 'docx-preview reflows the document: it has no verified page model, so page citations need the prepared PDF', true);
      return fail('unsupported-target', `target kind ${t.kind} does not apply to a Word document`, true);
    },
  };
}
