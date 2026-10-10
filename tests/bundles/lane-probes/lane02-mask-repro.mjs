// Synthetic repro: CC-09 register entries cover differences unrelated to their stated reason.
// CC-09-r2 copy of lane 02's probe; its synthetic date changed to 1901-01-01 (a leak-scan needle matched the original).
import { readFileSync } from 'node:fs';
const W = process.argv[2];
const { covering } = await import(`${W}/scripts/parity/lib/compare.mjs`);
const { entries } = JSON.parse(readFileSync(`${W}/docs/reference/parity/register/CC-09.json`, 'utf8'));
const NS = 'not in the verified index; not served';
const cases = [
	['court_bundle_tab', 'sweep.bundle_tabs.items.r0', '1 | A-1 | Synthetic letter | a.pdf p 1–2 | 2 | 001 – 002 | Open item', `1 | A-9 | WRONG text | b.pdf p 7–9 | 99 | 900 – 999 | Open item (${NS})`],
	['discovery_tab', 'sweep.bundle.index_text', '<table><tr><td class="n">1</td><td class="d">1901-01-01</td><td>a.pdf</td></tr></table>', '<div class="cap"><b>INCOMPLETE SELECTION</b>: x.</div><table><tr><td class="n">7</td><td class="d"></td><td>WRONG.pdf</td></tr></table>'],
	['discovery_tab', 'sweep.marks.cover_text', '<td class="co">C</td><td class="co">C</td><td class="co">C</td>', '<td class="co">O</td><td class="co">O</td><td class="co">O</td>'],
	['discovery_tab', 'table.table_1.row.7.document_s_description', 'Synthetic description a.pdf OpenDownload', `COMPLETELY DIFFERENT z.pdf (${NS})`],
	['court_bundle_tab', 'control.row:link:X', '1', '<absent>'],
];
for (const [view, path, v5, app] of cases) {
	const e = covering(entries, view, { path, kind: app === '<absent>' ? 'v5-only' : 'value', v5, app });
	console.log(`${path}: ${e ? 'COVERED by ' + e.id + ' (' + e.type + ')' : 'UNREGISTERED'}`);
}
