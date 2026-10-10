// Synthetic check: which values IDR-350 and IDR-360 cover (no case data).
import { readFileSync } from 'node:fs';
import { covering } from '../../scripts/parity/lib/compare.mjs';
const doc = JSON.parse(readFileSync('docs/reference/parity/register/CC-09.json', 'utf8'));
const entries = doc.entries ?? doc;
const NS = 'not in the verified index; not served';
const cases = [
  ['court_bundle_tab', { path: 'sweep.bundle_tabs.items.r0', kind: 'value', v5: '1 OD-1 Invented description Invented.pdf ↗ pp 1–3 of source 3 001 – 003 Open item', app: `1 OD-1 Invented description Invented.pdf ↗ pp 1–3 of source 3 001 – 003 Open item (${NS})` }, 'only the not-served action differs'],
  ['court_bundle_tab', { path: 'sweep.bundle_tabs.items.r0', kind: 'value', v5: '1 OD-1 Invented description Invented.pdf ↗ pp 1–3 of source 3 001 – 003 Open item', app: `7 XX-9 WRONG description Other.pdf ↗ pp 9–9 of source 99 777 – 999 Open item (${NS})` }, 'item no, key, description, source, pages and page numbers all wrong'],
  ['court_bundle_tab', { path: 'sweep.bundle_tabs.items.r99', kind: 'app-only', v5: '<absent>', app: `99 EXTRA row the app invented 001 – 001 Open item (${NS})` }, 'an extra row only the app shows'],
  ['discovery_tab', { path: 'table.table_1.row.4.document_s_description', kind: 'value', v5: 'Invented description Invented.pdf CO OpenDownload', app: `Invented description Invented.pdf CO ${NS}` }, 'only the not-served file differs'],
  ['discovery_tab', { path: 'table.table_1.row.4.document_s_description', kind: 'value', v5: 'Invented description Invented.pdf CO OpenDownload', app: `TOTALLY DIFFERENT description Wrong.pdf CO ${NS}` }, 'description and file name wrong'],
];
for (const [view, d, what] of cases) { const e = covering(entries, view, d); console.log(`${view} ${d.path} [${what}] -> ${e ? e.id : 'UNREGISTERED'}`); }
