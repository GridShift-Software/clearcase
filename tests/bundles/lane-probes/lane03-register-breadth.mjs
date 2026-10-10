// Does the register cover synthetic regressions in rows that also carry the not-served marker?
import { covering } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister } from '../../scripts/parity/lib/register.mjs';
const { entries } = loadRegister();
const M = 'not in the verified index; not served';
const cases = {
	// items tab row: v5 "… 005 – 007 … Open item Save extract", app with WRONG page numbers and a not-served extract
	items_wrong_pages: { view: 'court_bundle_tab', d: { path: 'sweep.bundle_tabs.items.r3', kind: 'value', v5: '3 OD-3 SYNTHETIC LETTER a.pdf ↗ pp 2–4 of source 3 005 – 007 Open item Save extract', app: `3 OD-3 SYNTHETIC LETTER a.pdf ↗ pp 2–4 of source 3 009 – 011 Extract (${M})` } },
	items_wrong_desc: { view: 'court_bundle_tab', d: { path: 'sweep.bundle_tabs.items.r3', kind: 'value', v5: '3 OD-3 SYNTHETIC LETTER 3 005 – 007 Open item', app: `3 OD-4 A DIFFERENT DOCUMENT 3 005 – 007 Extract (${M})` } },
	// schedule cell: v5 "desc file.pdf C O OpenDownload", app with a WRONG description and a not-served file
	schedule_wrong_desc: { view: 'discovery_tab', d: { path: 'table.table_1.row.40.document_s_description', kind: 'value', v5: 'Synthetic letter of demand file.pdf C O OpenDownload', app: `A different item entirely other.pdf C O ${M}` } },
	// control: the same regression in a row without the marker must stay unregistered
	control_no_marker: { view: 'court_bundle_tab', d: { path: 'sweep.bundle_tabs.items.r3', kind: 'value', v5: '3 X 005 – 007 Open item', app: '3 X 009 – 011 Open item' } },
};
const out = {};
for (const [k, { view, d }] of Object.entries(cases)) out[k] = covering(entries, view, d)?.id ?? null;
console.log(JSON.stringify(out));
