// A synthetic hosted app on loopback for the journey probes: healthy pages, and per scenario the broken markup a false pass
// once slipped through. Nothing here comes from a case; every ref, name and value is invented.
import http from 'node:http';

export const CASE = 'probe', RV = 'rv1', SHA = 'probe-sha';
export const REFS = ['PRB-1', 'PRB-2', 'PRB-3'];
const V = `/cases/${CASE}/v/${RV}`;
const original = ref => `/cases/${CASE}/originals/A-${ref}`;

const CSS = `
  body { font: 14px sans-serif; margin: 8px; }
  .split { display: flex; gap: 16px; } .split > [data-testid="chronology-list"] { width: 60%; } .split > section { width: 38%; }
  .grid-head, .grid-row { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); column-gap: 2px; overflow-wrap: anywhere; }
  .pane-back { display: none; } [data-slot] > h2 { text-transform: uppercase; }
  @media (max-width: 600px) { .split { display: block; } .split > * { width: auto !important; } .grid-head { font-size: 8px; } .pane-back { display: block; } }`;
const NAV = [['overview', 'overview'], ['matter', 'analysis/matter'], ['heads_tab', 'litigation/heads_tab'], ['people', 'evidence/people'], ['contracts_tab', 'evidence/contracts_tab']];
const page = (id, body, { wrap = m => m, style = '', script = '' } = {}) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>${id}</title><style>${CSS}${style}</style></head><body>
<nav aria-label="Case views">${NAV.map(([v, path]) => `<a data-view="${v}" href="${V}/${path}">${v}</a>`).join(' ')}</nav>
${wrap(`<main data-ready="${id}"><h1>${id}</h1>${body}</main>`)}${script ? `<script>${script}</script>` : ''}</body></html>`;
const bare = (body, attrs = '') => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body${attrs}>${body}</body></html>`;

const TABLE = '<table><tbody><tr><td>Synthetic row</td><td>Value one</td></tr><tr><td>Second row</td><td>Value two</td></tr></tbody></table>';
const heads = ({ usable = true, entries = 0 } = {}) => `<form id="hd-add"><input type="hidden" name="addId" value="a">
  <input id="hd_head" ${usable ? '' : 'disabled'}><input id="hd_sub" ${usable ? '' : 'disabled'}>${usable ? '<button type="submit">Add</button>' : ''}</form>
  <table id="heads-table"><tbody>${entries
    ? Array.from({ length: entries }, (_, i) => `<tr data-row="r${i}"><td>${i + 1}</td><td><b>Heading ${i + 1}</b></td><td>A synthetic submission</td><td>An authority</td><td>PRB-1</td><td><button type="button">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty">No submissions yet.</div></td></tr>'}</tbody></table>`;
// A table whose only row is a loading placeholder, and Overview tiles whose titles and values sit in hidden children (PR #206 review).
const PLACEHOLDER_ROWS = '<table><tbody><tr class="placeholder"><td>Loading…</td><td>Please wait</td></tr></tbody></table>';
const hideSlotText = html => html.replace(/<h2>(Open deadlines|Unbilled time|Freshness)<\/h2>/g, '<h2 style="min-height:20px"><span hidden>$1</span></h2>')
  .replace(/<p class="num">([^<]+)<\/p>/g, '<p class="num" style="min-height:20px"><span hidden>$1</span></p>')
  .replace(/<p id="freshness-stamp">([^<]+)<\/p>/, '<p id="freshness-stamp" style="min-height:20px"><span hidden>$1</span></p>');
const ANALYSIS = {
  matter: '<section id="matter-storyline-card"><h2>Storyline</h2><p class="narrative">A synthetic storyline for the probe.</p></section>',
  timeline: `<div data-phase="0"><div role="listitem"><a href="${V}/doc/PRB-1">A synthetic event</a></div></div>`,
  conflict_tab: '<select id="confsel"><option>Choose</option><option>Party A</option></select><input id="confq">',
  interest_calc_tab: '<p class="narrative">An imported interest note.</p><form id="ic-form"><input id="ic_p" value="100"></form>',
  heads_tab: heads(),
  settlement_tab: '<p class="narrative">An imported claim.</p><form id="se-form"><input id="se_claim" value="1,000"></form><div id="se_out">A modelled outcome</div>',
};
export const VIEWS = {
  analysis: ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'],
  evidence: ['people', 'entity_ledger_tab', 'contracts_tab', 'filings_tab'],
  litigation: ['conflict_tab', 'enforcement_tab', 'legality_tab', 'elements_tab', 'authorities_tab', 'heads_tab', 'crossexam_tab'],
  quantum: ['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'settlement_tab'],
};
const analysis = (id, body = ANALYSIS[id] ?? TABLE, empty = id === 'heads_tab') => page(id, body, { wrap: m => `<div data-testid="analysis-content" data-empty="${empty}">${m}</div>` });

const slot = (id, title, body) => `<section data-slot="${id}" data-slot-status="filled"><h2>${title}</h2>${body}</section>`;
const FRESHNESS = '<p id="freshness-stamp">Built for the probe · 3 documents indexed.</p>';
const overview = (freshness = FRESHNESS) => page('overview', `<p class="num" id="count-documents" data-testid="overview-document-count">3</p>
  ${slot('deadlines', 'Open deadlines', '<p class="num">2</p><p><small>in the deadline tracker</small></p>')}${slot('unbilled-time', 'Unbilled time', '<p class="num">1.5 h</p>')}${slot('rescan-freshness', 'Freshness', freshness)}
  <section><h2>Dates</h2><p id="date-span">Date span: first → last</p></section>${TABLE}`);

// What a viewer's draw puts on its canvases, as pdf.js does: the white page, then its content. A canvas's data-paint picks the
// content: dark ink (default), light grey only ("light"), or none, a legitimately blank page ("white"). GRS-273, fix round 1.
const draw = "document.querySelectorAll('canvas').forEach(c => { const x = c.getContext('2d'), p = c.dataset.paint; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); if (p === 'white') return; x.fillStyle = p === 'light' ? 'rgb(230,230,230)' : '#345'; x.fillRect(10, 10, 50, 50); });";
// What the chronology pane shows for a row, as the hosted HostedOriginal.svelte renders it.
const viewerLink = ref => `<p class="pane-original"><span>${ref}.pdf</span> <a data-action="open-viewer" href="${original(ref)}/view">Open full viewer</a></p>`;
const download = (ref, label = 'Download the original') => `<a data-action="download-original" href="${original(ref)}?download=1">${label}</a>`;
const pdfPane = paint => ref => `${viewerLink(ref)}<div data-viewer="pdf" data-viewer-state="ready"><p>${download(ref, 'Download')}</p><canvas data-testid="pdf-page" data-page-number="1" data-rendered="true"${paint ? ` data-paint="${paint}"` : ''} width="200" height="280"></canvas></div>`;
const PANE = {
  pdf: pdfPane(),
  'pdf-white': pdfPane('white'),
  'pdf-light': pdfPane('light'),
  'download-only': ref => `${viewerLink(ref)}<p class="pane-state" data-pane-state="download-only">This file type is not shown in the app. ${download(ref)}.</p>`,
  email: ref => `${viewerLink(ref)}<p class="pane-state" data-pane-state="email">This email opens in the full viewer. <a href="${original(ref)}/view">Open it</a> or ${download(ref, 'download the original')}.</p>`,
  'download-only-unlinked': ref => `${viewerLink(ref)}<p class="pane-state" data-pane-state="download-only">This file type is not shown in the app.</p>`,
};
const chronology = ({ states = ['pdf', 'download-only', 'email'], delay = 0, phoneDelay = 0, phoneHeadings = true, phoneImage = false, blank = false } = {}) => {
  const heads = ['Preview', 'Date', 'Ref', 'Title / subject', 'Type', 'Bundle', 'Amount', 'Status', 'Original'].map(h => `<span role="columnheader">${h}</span>`).join('');
  const rows = states.map((_, i) => `<div class="grid-row" role="row" data-ref="${REFS[i]}"><span role="cell"><button class="preview" data-i="${i}">Preview</button></span>
    <span role="cell">day ${i + 1}</span><span role="cell"><a href="${V}/doc/${REFS[i]}">${REFS[i]}</a></span><span role="cell">Synthetic subject</span><span role="cell">letter</span>
    <span role="cell">A</span><span role="cell">-</span><span role="cell">text</span><span role="cell" data-file="present">present</span></div>`).join('');
  const panes = Object.fromEntries(states.map((s, i) => [REFS[i], PANE[s](REFS[i])]));
  return page('chronology', `<div class="split"><div data-testid="chronology-list"><div class="grid-head" role="row">${heads}</div>${rows}</div>
    <section data-testid="chronology-document-pane"><p class="pane-back"><button type="button">Back to list</button></p><div id="pane-body"><p data-pane-state="none">Select a document.</p></div></section></div>`, {
    style: phoneHeadings ? '' : '@media (max-width: 600px) { .grid-head { display: none; } }',
    script: `const panes = ${JSON.stringify(panes)}, pane = document.querySelector('[data-testid="chronology-document-pane"]'), body = document.getElementById('pane-body');
      document.querySelectorAll('button.preview').forEach(b => b.addEventListener('click', () => {
        const ref = b.closest('[data-ref]').dataset.ref; pane.dataset.ref = ref;
        body.innerHTML = '<p class="pane-state" data-pane-state="loading" role="status">Loading the original…</p>';
        setTimeout(() => { body.innerHTML = panes[ref]; ${blank ? '' : draw} }, innerWidth < 600 ? ${phoneDelay} : ${delay});
      }));
      pane.querySelector('.pane-back button').addEventListener('click', () => { delete pane.dataset.ref; body.innerHTML = ''; });
      ${phoneImage ? "if (innerWidth < 600) { const i = document.createElement('img'); i.alt = 'decoration'; i.src = '/probe/phone-only.png'; document.body.append(i); }" : ''}`,
  });
};

const documents = () => page('documents', `<input data-testid="document-filter" id="doc-filter"><table><tbody>${REFS.map(r => `<tr><td><a href="${V}/doc/${r}">${r}</a></td><td>pdf</td></tr>`).join('')}</tbody></table>`);
const doc = ref => page(`doc:${ref}`, `<p id="original-state" data-testid="original-metadata">PDF, 1,234 bytes</p>
  <a data-testid="open-original" id="open-original" target="_blank" href="${original(ref)}/view">Open original</a>`);
// The opened original: the hosted viewer, or the local isolated viewer's window.__viewer, healthy or in its error state.
const VIEWER = {
  hosted: () => bare(`<div data-viewer="pdf" data-viewer-state="ready"><canvas data-testid="pdf-page" data-page-number="1" data-rendered="true" width="300" height="400"></canvas></div><script>${draw}</script>`),
  legacy: () => bare(`<div data-page="1" data-rendered="1"><canvas width="300" height="400"></canvas></div><script>window.__viewer = { rendered: 1, error: null }; ${draw}</script>`, ' data-ready="1"'),
  'hosted-error': () => bare('<div data-viewer="pdf" data-viewer-state="error"><p role="alert">This file cannot be displayed here.</p></div><canvas data-testid="pdf-page" data-page-number="1" data-rendered="true" width="300" height="400" style="display:none"></canvas>'),
  // A drawn page 1 that is legitimately blank, and one whose only content is light grey (GRS-273, fix round 1).
  'hosted-white': () => bare(`<div data-viewer="pdf" data-viewer-state="ready"><canvas data-testid="pdf-page" data-page-number="1" data-rendered="true" data-paint="white" width="300" height="400"></canvas></div><script>${draw}</script>`),
  'legacy-light': () => bare(`<div data-page="1" data-rendered="1"><canvas data-paint="light" width="300" height="400"></canvas></div><script>window.__viewer = { rendered: 1, error: null }; ${draw}</script>`, ' data-ready="1"'),
  // GRS-273: the flags of a drawn page 1 over a canvas that holds nothing.
  'hosted-blank': () => bare('<div data-viewer="pdf" data-viewer-state="ready"><canvas data-testid="pdf-page" data-page-number="1" data-rendered="true" width="300" height="400"></canvas></div>'),
  'legacy-blank': () => bare('<div data-page="1" data-rendered="1"><canvas width="300" height="400"></canvas></div><script>window.__viewer = { rendered: 1, error: null };</script>', ' data-ready="1"'),
  'legacy-error': () => bare('<p id="status">This file cannot be displayed. Use Download.</p><canvas width="300" height="400" style="display:none"></canvas><script>window.__viewer = { rendered: 1, error: "probe" };</script>'),
};

/** Each scenario's pages that differ from the healthy app, by path under the version (or the original's viewer, by ref). */
export const SCENARIOS = {
  healthy: {},
  h1: {
    'analysis/matter': () => page('matter', '<p role="alert">This original is no longer available.</p>'),
    'evidence/people': () => page('people', TABLE.replace('<table>', '<table aria-busy="true">')),
    'evidence/contracts_tab': () => page('contracts_tab', '<section data-unavailable="contracts_tab"><h2>Not available here</h2><p>This view is not offered.</p></section>'),
  },
  h2: { overview: () => overview('<p>Unable to load dates.</p>') },
  h3: { 'evidence/contracts_tab': () => analysis('contracts_tab', '<table><tbody><tr style="display:none"><td>Error</td><td>Could not load</td></tr></tbody></table>', true) },
  h4: { viewer: { 'PRB-1': 'hosted-error', 'PRB-2': 'legacy-error' } },
  h5: { chronology: () => chronology({ phoneImage: true }) },
  h6: { chronology: () => chronology({ states: ['download-only-unlinked', 'pdf', 'email'] }) },
  m1: { chronology: () => chronology({ delay: 3200 }) },
  m2: { 'litigation/heads_tab': () => analysis('heads_tab', heads({ usable: false })) },
  m3: { chronology: () => chronology({ states: ['pdf'], phoneHeadings: false }) },
  'h1-placeholder': { 'evidence/people': () => page('people', PLACEHOLDER_ROWS) },
  'h2-hidden-text': { overview: () => hideSlotText(overview()) },
  'h3-placeholder': { 'evidence/contracts_tab': () => analysis('contracts_tab', PLACEHOLDER_ROWS, false) },
  'm1-phone': { chronology: () => chronology({ phoneDelay: 3200 }) },
  // A healthy case whose first chronology original and small sample have a blank page 1 and whose medium sample is light grey;
  // PRB-3 is the scan that draws ink.
  'light-first-page': { chronology: () => chronology({ states: ['pdf-white', 'pdf-light', 'email'] }), viewer: { 'PRB-1': 'hosted-white', 'PRB-2': 'legacy-light' } },
  'blank-canvas': { chronology: () => chronology({ blank: true }), viewer: { 'PRB-1': 'hosted-blank', 'PRB-2': 'legacy-blank' } },
  'heads-seeded': { 'litigation/heads_tab': () => analysis('heads_tab', heads({ entries: 2 }), false) },
};
const HEALTHY_VIEWER = { 'PRB-1': 'hosted', 'PRB-2': 'legacy', 'PRB-3': 'hosted' };

function render(scenario, pathname) {
  const broken = SCENARIOS[scenario];
  const viewer = pathname.match(new RegExp(`^/cases/${CASE}/originals/A-([^/]+)/view$`));
  if (viewer) return VIEWER[broken.viewer?.[viewer[1]] ?? HEALTHY_VIEWER[viewer[1]]]?.();
  if (!pathname.startsWith(`${V}/`)) return null;
  const suffix = pathname.slice(V.length + 1);
  if (broken[suffix]) return broken[suffix]();
  if (suffix === 'overview') return overview();
  if (suffix === 'chronology') return chronology();
  if (suffix === 'evidence/documents') return documents();
  if (suffix.startsWith('doc/') && REFS.includes(suffix.slice(4))) return doc(suffix.slice(4));
  const [category, id] = suffix.split('/');
  return VIEWS[category]?.includes(id) ? analysis(id) : null;
}

/** Serves `scenario` on a free loopback port; resolves to its origin and a close function. */
export function serve(scenario) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://probe');
    if (pathname === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, build: { revision: SHA, buildId: 'probe-build' } }));
    if (pathname === '/probe/phone-only.png') return res.writeHead(503).end();
    const html = render(scenario, pathname);
    if (html) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    res.writeHead(404).end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}
