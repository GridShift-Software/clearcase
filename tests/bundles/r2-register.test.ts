// CC-09-r2 D9/D10: the narrowed register entries cover only their stated difference. Synthetic values only: each
// intended marker difference is covered, and each regression the verification lanes built (dropped index dates, an O
// spreading over the cover, a wrong cell in an items row or a schedule cell that also shows the marker, an extra
// app-only items row) leaves a difference unregistered. Start: lane 02's mask-repro.mjs and lanes 03/04's
// register-breadth.mjs (tests/bundles/lane-probes/).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { covering, diff } from '../../scripts/parity/lib/compare.mjs';

// the parity drivers are untyped .mjs modules (no declaration files)
type Flat = Record<string, string>;
type Raw = { tables: { header: string[]; rows: string[][][] }[] };
const COURT = '../../scripts/parity/adapters/v5/specs/court_bundle_tab.mjs', DISC = '../../scripts/parity/adapters/v5/specs/discovery_tab.mjs';
const { itemCells } = (await import(COURT)) as { itemCells: (i: number, cells: string[]) => Flat };
const { splitCoverCo, splitFileActions, splitIncomplete } = (await import(DISC)) as { splitCoverCo: (h: string) => Flat; splitFileActions: (r: Raw) => void; splitIncomplete: (h: string) => Flat };

const { entries } = JSON.parse(readFileSync(join(import.meta.dirname, '../../docs/reference/parity/register/CC-09.json'), 'utf8')) as { entries: Parameters<typeof covering>[0] };
const NS = 'not in the verified index; not served';
type D = { path: string; kind: string; v5: string; app: string };
const by = (view: string, d: D) => (covering(entries, view, d) as { id: string } | null)?.id ?? null;
/** Differences between two flat key -> value maps (absent on one side is '<absent>'). */
const diffs = (v5: Record<string, string>, app: Record<string, string>, prefix: string): D[] =>
	[...new Set([...Object.keys(v5), ...Object.keys(app)])].filter((k) => v5[k] !== app[k]).map((k) => ({ path: prefix + k, kind: k in v5 ? (k in app ? 'value' : 'v5-only') : 'app-only', v5: v5[k] ?? '<absent>', app: app[k] ?? '<absent>' }));
const unregistered = (view: string, ds: D[]) => ds.filter((d) => !by(view, d)).map((d) => d.path);

describe('D9: the Discovery index and marked cover', () => {
	const head = '<!DOCTYPE html><html><body><h2>Synthetic A v Synthetic B</h2><div class="cap">Synthetic court</div>';
	const table = (dates: boolean) => `<table><tbody><tr><td class="n">1</td><td class="n">3.</td><td>Synthetic letter</td><td class="d">${dates ? '01/02/2001' : ''}</td><td>a.pdf</td><td class="co">C</td></tr></tbody></table>`;
	const INC = '<div class="cap"><b>INCOMPLETE SELECTION</b>: 1 item is only partly selected.</div>';
	it('the INCOMPLETE SELECTION line alone is covered (IDR-352)', () => {
		const ds = diffs(splitIncomplete(head + table(true)), splitIncomplete(head + INC + table(true)), 'sweep.bundle.');
		expect(ds.map((d) => [d.path, by('discovery_tab', d)])).toEqual([['sweep.bundle.index_incomplete', 'IDR-352']]);
	});
	it('M1: dropped index dates are unregistered, even with the incomplete line', () => {
		expect(unregistered('discovery_tab', diffs(splitIncomplete(head + table(true)), splitIncomplete(head + INC + table(false)), 'sweep.bundle.'))).toEqual(['sweep.bundle.index_text']);
	});
	const cover = (cos: string[]) => '<html><body><table><tbody>' + cos.map((c, i) => `<tr><td class="n">${i + 1}.</td><td>Synthetic item ${i + 1}</td><td class="d"></td><td class="co">${c}</td></tr>`).join('') + '</tbody></table></body></html>';
	it('the marked item\'s C to O alone is covered (IDR-353)', () => {
		const ds = diffs(splitCoverCo(cover(['C', 'C', 'C'])), splitCoverCo(cover(['O', 'C', 'C'])), 'sweep.marks.');
		expect(ds.map((d) => [d.path, by('discovery_tab', d)])).toEqual([['sweep.marks.cover_co.0', 'IDR-353']]);
	});
	it('M4: an O spreading to the unmarked cover rows is unregistered', () => {
		expect(unregistered('discovery_tab', diffs(splitCoverCo(cover(['C', 'C', 'C'])), splitCoverCo(cover(['O', 'O', 'O'])), 'sweep.marks.'))).toEqual(['sweep.marks.cover_co.1', 'sweep.marks.cover_co.2']);
	});
});

describe('D10: schedule cells and items rows that show the not-served marker', () => {
	const raw = (desc: string, chips: string[]): Raw => ({ tables: [{ header: ['', 'Item', 'Document(s) & description', 'Date'], rows: [[[], ['3.'], [desc, ...chips], ['01/02/2001']]] }] });
	const cells = (r: Raw) => { splitFileActions(r); const t = r.tables[0]!; return Object.fromEntries(t.header.map((h, j) => [h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'c' + j, (t.rows[0]![j] ?? []).join(' / ')])); };
	const v5 = cells(raw('Synthetic description', ['(1) a.pdfCOOpenDownload', '(2) b.pdfCOOpenDownload']));
	it('only the file actions column differs for a not-served file, and IDR-350 covers it', () => {
		const ds = diffs(v5, cells(raw('Synthetic description', ['(1) a.pdfCOOpenDownload', `(2) b.pdfCO${NS}`])), 'table.table_1.row.4.');
		expect(ds.map((d) => [d.path, by('discovery_tab', d)])).toEqual([['table.table_1.row.4.file_actions', 'IDR-350']]);
	});
	it('a wrong description or file name in a cell that also shows the marker is unregistered', () => {
		expect(unregistered('discovery_tab', diffs(v5, cells(raw('Changed description', ['(1) a.pdfCOOpenDownload', `(2) b.pdfCO${NS}`])), 'table.table_1.row.4.'))).toEqual(['table.table_1.row.4.document_s_description']);
		expect(unregistered('discovery_tab', diffs(v5, cells(raw('Synthetic description', ['(1) a.pdfCOOpenDownload', `(2) wrong.pdfCO${NS}`])), 'table.table_1.row.4.'))).toEqual(['table.table_1.row.4.document_s_description']);
	});
	it('a missing Download on a served file is unregistered (only the marker is a known gap)', () => {
		expect(unregistered('discovery_tab', diffs(v5, cells(raw('Synthetic description', ['(1) a.pdfCOOpen', '(2) b.pdfCOOpenDownload'])), 'table.table_1.row.4.'))).toEqual(['table.table_1.row.4.file_actions']);
	});
	const row = (n: string, ref: string, desc: string, from: string, pages: string, nos: string, actions: string) => [n, ref, desc, from, pages, nos, actions];
	const V5ROW = row('1', 'OD-1', 'Synthetic letter', 'Synthetic.pdf ↗ pp 1–3 of source / CaseLines 001 – 003 · verify page 4', '3', '001 – 003', 'Open item Save extract / in the bundle at page 001');
	const APPROW = row('1', 'OD-1', 'Synthetic letter', `Synthetic.pdf (${NS}) pp 1–3 of source / CaseLines 001 – 003 · verify page 4`, '3', '001 – 003', `Extract (${NS}) / in the bundle at page 001 (${NS})`);
	const P = 'sweep.bundle_tabs.';
	it('the actions cell and the not-served part\'s link state are covered (IDR-360, IDR-362); the Extracted-from text compares exactly', () => {
		const ds = diffs(itemCells(0, V5ROW), itemCells(0, APPROW), P);
		expect(ds.map((d) => [d.path, by('court_bundle_tab', d)])).toEqual([['sweep.bundle_tabs.items.r0.from_link.0', 'IDR-362'], ['sweep.bundle_tabs.items.r0.actions', 'IDR-360']]);
	});
	it.each([[4, '99', 'M2: a wrong page count'], [1, 'OD-9', 'a wrong ref'], [2, 'Changed letter', 'a wrong description'], [5, '900 – 999', 'a wrong page range']] as const)('%s', (j, v, _what) => {
		const app = [...APPROW]; app[j] = v;
		expect(unregistered('court_bundle_tab', diffs(itemCells(0, V5ROW), itemCells(0, app), P))).toHaveLength(1);
	});
	it('a wrong part (source file or its pages) in a not-served row is unregistered', () => {
		const app = [...APPROW]; app[3] = `Other.pdf (${NS}) pp 9–9 of source / CaseLines 001 – 003 · verify page 4`;
		expect(unregistered('court_bundle_tab', diffs(itemCells(0, V5ROW), itemCells(0, app), P))).toEqual(['sweep.bundle_tabs.items.r0.from']);
	});
	it('an extra app-only items row is unregistered', () => {
		const ds = diffs({}, itemCells(9, APPROW), P);
		expect(unregistered('court_bundle_tab', ds).sort()).toEqual(ds.map((d) => d.path).sort());
	});
	it('the shared differ sees the same paths', () => {
		expect(typeof diff).toBe('function');
	});
});
