import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'word';
const DP = 'docx-preview 0.4.1';
const PR = 'prepared PDF (LibreOffice) + pdf.js';
const TOKENS = ['WORD-P1-HEADING', 'WORD-P1-BODY', 'WORD-FOOTNOTE-TOKEN', 'WORD-COMMENTED-SPAN', 'WORD-COMMENT-TOKEN', 'WORD-INSERTED-TOKEN', 'WORD-DELETED-TOKEN', 'WORD-TABLE-B2', 'WORD-EXTERNAL-LINK', 'WORD-P2-BODY', 'WORD-P3-LANDSCAPE', 'WORD-HEADER-TOKEN', 'WORD-FOOTER-TOKEN'];
const pageText = (c, n) => c.inFrame(async (n) => { for (let i = 0; i < 100; i++) { const t = window.__pdf.renderedText(n); if (t) return t; await new Promise((r) => setTimeout(r, 50)); } return ''; }, n);

export default async function word(c, { full }) {
  let id = 'word/full-content.rendition-v1.pdf';
  await opens(c, F, id, PR, { kind: 'rendition-page', version: 1, page: 1 });
  await layout(c, F, id, PR);
  if (!full) { await accepts(c, F, id, PR, { kind: 'rendition-page', version: 1, page: 3 }, 'page 3 of 3', async () => (await pageText(c, 3)).includes('WORD-P3-LANDSCAPE')); return; }
  // prepared rendition: content and pagination
  const text = await c.inFrame(async () => { const out = []; for (let n = 1; n <= window.__r.pdf.numPages; n++) out.push(await window.__pdf.textOf(n)); return out; });
  const all = text.join(' ');
  const missing = TOKENS.filter((t) => !all.includes(t));
  c.record(F, id, PR, 'prepared PDF carries every content token', missing.length === 0, 'all 13 tokens in the text layer', { missing });
  c.record(F, id, PR, 'prepared PDF pagination follows the manual break and landscape section', text.length === 3 && text[1].includes('WORD-P2-BODY') && text[2].includes('WORD-P3-LANDSCAPE'), '3 pages; P2 token on page 2; landscape token on page 3', text.map((t) => t.slice(0, 60)));
  c.record(F, id, PR, 'prepared PDF is tagged (structure tree present)', await c.inFrame(() => window.__pdf.struct(1)), 'page 1 getStructTree() is non-null', null);
  await accepts(c, F, id, PR, { kind: 'rendition-page', version: 1, page: 2 }, 'generated pagination', async () => (await pageText(c, 2)).includes('WORD-P2-BODY'));
  await rejects(c, F, id, PR, [[{ kind: 'rendition-page', version: 2, page: 2 }, 'stale-rendition'], [{ kind: 'rendition-page', version: 1, page: 4 }, 'invalid-target'], [{ kind: 'original-page', page: 2 }, 'unmapped-original-location']], () => c.inFrame(() => window.__r.pdf.current));
  const mapped = c.alias(id, `${id}@verified-map`, { rendition: { version: 1, page: null, mapping: { kind: 'verified', pages: { 1: 1, 2: 2, 3: 3 } } } });
  await opens(c, F, mapped, PR);
  await accepts(c, F, mapped, PR, { kind: 'original-page', page: 3 }, 'Original page 3, shown as processed preview v1 page 3', async () => (await pageText(c, 3)).includes('WORD-P3-LANDSCAPE'));
  await rejects(c, F, mapped, PR, [[{ kind: 'original-page', page: 4 }, 'unmapped-original-location']], () => c.inFrame(() => window.__r.pdf.current));
  await keyboardRoundTrip(c, F, id, PR);

  id = 'word/full-content.default-export.pdf';
  await opens(c, F, id, 'LibreOffice default PDF export + pdf.js');
  const def = (await c.inFrame(async () => { const o = []; for (let n = 1; n <= window.__r.pdf.numPages; n++) o.push(await window.__pdf.textOf(n)); return o; })).join(' ');
  c.record(F, id, 'LibreOffice default PDF export + pdf.js', 'default export (no options) keeps comments', def.includes('WORD-COMMENT-TOKEN'), 'WORD-COMMENT-TOKEN in the text layer (FAIL = the recipe must set ExportNotesInMargin)', { missing: TOKENS.filter((t) => !def.includes(t)) });

  id = 'word/legacy.rendition-v1.pdf';
  await opens(c, F, id, PR);
  const legacy = (await c.inFrame(async () => { const o = []; for (let n = 1; n <= window.__r.pdf.numPages; n++) o.push(await window.__pdf.textOf(n)); return o; })).join(' ');
  c.record(F, 'word/legacy.doc', PR, 'legacy DOC reaches the reader through its prepared PDF', ['WORD-P1-BODY', 'WORD-P2-BODY', 'WORD-P3-LANDSCAPE', 'WORD-TABLE-B2'].every((t) => legacy.includes(t)), 'prepared PDF of the .doc carries body, page-2, landscape and table tokens', null);

  // docx-preview, default (pre-read) options
  id = 'word/full-content.docx';
  const e0 = c.mon.egress.length;
  await opens(c, F, id, DP);
  await sleep(300);
  let st = await c.rstate();
  const shown = TOKENS.filter((t) => st.word.text.includes(t));
  c.record(F, id, DP, 'body, table, header/footer and footnote text rendered', ['WORD-P1-HEADING', 'WORD-P1-BODY', 'WORD-TABLE-B2', 'WORD-P2-BODY', 'WORD-P3-LANDSCAPE', 'WORD-HEADER-TOKEN', 'WORD-FOOTER-TOKEN', 'WORD-FOOTNOTE-TOKEN'].every((t) => shown.includes(t)), 'tokens for body/table/sections/header/footer/footnote in innerText', { shown });
  c.record(F, id, DP, 'comments visible with default options', shown.includes('WORD-COMMENT-TOKEN'), 'WORD-COMMENT-TOKEN in innerText (renderComments=false)', { shown });
  c.record(F, id, DP, 'tracked deletion visible with default options', shown.includes('WORD-DELETED-TOKEN'), 'WORD-DELETED-TOKEN in innerText (renderChanges=false)', { shown });
  c.record(F, id, DP, 'external image/link neither fetched nor left active', c.egressSince(e0).length === 0 && st.word.stripped >= 1, 'no egress; adapter stripped >= 1 external URL', { stripped: st.word.stripped, blocked: st.blocked });
  c.record(F, id, DP, 'page model: explicit breaks only (3 sections), no verified pagination', st.word.sections === 3, 'section.docx count === 3 (manual break + section break); automatic pagination not implemented upstream', st.word.sections);
  await rejects(c, F, id, DP, [[{ kind: 'original-page', page: 2 }, 'unmapped-original-location']], async () => (await c.rstate()).word.sections);
  await opens(c, F, id, `${DP} (renderComments+renderChanges)`, { kind: 'file' }, { adapterOptions: { renderComments: true, renderChanges: true, experimental: true } });
  st = await c.rstate();
  c.record(F, id, `${DP} (renderComments+renderChanges)`, 'comments and tracked changes visible when enabled', st.word.text.includes('WORD-COMMENT-TOKEN') && st.word.text.includes('WORD-DELETED-TOKEN'), 'both tokens in innerText', { comment: st.word.text.includes('WORD-COMMENT-TOKEN'), deleted: st.word.text.includes('WORD-DELETED-TOKEN') });

  id = 'word/altchunk.docx';
  for (const alt of [false, true]) {
    const e1 = c.mon.egress.length;
    await opens(c, F, id, `${DP} (renderAltChunks=${alt})`, { kind: 'file' }, { adapterOptions: { renderAltChunks: alt } });
    await sleep(500);
    st = await c.rstate();
    c.record(F, id, `${DP} (renderAltChunks=${alt})`, 'altChunk HTML cannot run script, fetch or submit', c.egressSince(e1).length === 0, 'no egress (CSP blocks; sandbox has no forms)', { iframes: st.word.iframes, shownHtmlToken: st.word.text.includes('ALTCHUNK-HTML-TOKEN'), blocked: st.blocked });
  }
  const r = await c.open('word/legacy.doc');
  c.record(F, 'word/legacy.doc', DP, 'legacy DOC is not readable by docx-preview (needs the prepared PDF)', r.type === 'error' && r.code === 'not-docx', "error 'not-docx'", { code: r.code });
}
