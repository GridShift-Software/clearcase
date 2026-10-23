import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, excerptPreview, filterRows, optionsOf, paramsFromQuery, queryFromParams, queryRows, sortRows, statusLabel, statusOptions, TEXT_STATUSES } from './chronology.ts';
import type { ChronologyListRow } from './model.ts';

const r = (ref: string, ord: number, o: Partial<ChronologyListRow> = {}): ChronologyListRow => ({
	ref, ord, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Original', subject: '', filename: `${ref}.pdf`, sender: '', to: '', excerpt: '',
	amount: '', alsoIn: [], url: '', textStatus: 'extracted', parentRef: null, file: 'present', preview: 'inline-isolated', attachments: 0, ...o,
});
const rows = [
	r('B-2', 0, { date: '2001-01-02', amount: '10', bundle: 'Additional', subject: 'Invoice one' }),
	r('A-1', 1, { date: '', amount: '' }),
	r('C-3', 2, { date: '2001-01-02', amount: '10.5', docType: 'email', sender: 'Ann' }),
	r('D-4', 3, { date: '2000-12-31', amount: 'abc', textStatus: 'none', excerpt: 'mentions INVOICE' }),
	r('E-5', 4, { date: '', amount: '10' }),
];
const refs = (xs: ChronologyListRow[]) => xs.map((x) => x.ref);

describe('chronology', () => {
	it('sorts by date ascending with undated first and ties in source order, and descending with ties in source order', () => {
		expect(refs(sortRows(rows, 'date', 1))).toEqual(['A-1', 'E-5', 'D-4', 'B-2', 'C-3']);
		expect(refs(sortRows(rows, 'date', -1))).toEqual(['B-2', 'C-3', 'D-4', 'A-1', 'E-5']);
	});
	it('sorts amounts by parseFloat with empty and non-numbers as 0, stably', () => {
		expect(refs(sortRows(rows, 'amount', -1))).toEqual(['C-3', 'B-2', 'E-5', 'A-1', 'D-4']);
		expect(refs(sortRows(rows, 'amount', 1))).toEqual(['A-1', 'D-4', 'B-2', 'E-5', 'C-3']);
	});
	it('filters by exact bundle/type/status and a case-insensitive substring over filename, ref, subject, sender and excerpt', () => {
		expect(refs(filterRows(rows, { ...DEFAULT_QUERY, q: 'invoice' }))).toEqual(['B-2', 'D-4']);
		expect(refs(filterRows(rows, { ...DEFAULT_QUERY, q: 'ann' }))).toEqual(['C-3']);
		expect(refs(filterRows(rows, { ...DEFAULT_QUERY, bundle: 'Additional' }))).toEqual(['B-2']);
		expect(refs(filterRows(rows, { ...DEFAULT_QUERY, type: 'email', status: 'extracted' }))).toEqual(['C-3']);
		expect(refs(queryRows(rows, { ...DEFAULT_QUERY, q: 'pdf', sort: 'ref', dir: 1 }))).toEqual(['A-1', 'B-2', 'C-3', 'D-4', 'E-5']);
	});
	it('offers every imported bundle, including non-standard ones', () => {
		expect(optionsOf(rows, 'bundle')).toEqual(['Additional', 'Original']);
	});
	it('orders every imported bundle in a synthetic six-bundle case', () => {
		const six = ['Witness', 'Original', 'Claims', 'Pleadings', 'Correspondence', 'Additional'].map((bundle, i) => r(`S-${i}`, i, { bundle }));
		expect(optionsOf([...six, r('S-repeat', 6, { bundle: 'Claims' })], 'bundle')).toEqual(['Additional', 'Claims', 'Correspondence', 'Original', 'Pleadings', 'Witness']);
	});
	it('offers the whole text-status vocabulary in v5 order, even statuses no row has, then any other status', () => {
		expect(statusOptions(rows)).toEqual(['extracted', 'ocr', 'none', 'pending']);
		expect(statusOptions([...rows, r('F-6', 5, { textStatus: 'unsupported' })])).toEqual([...TEXT_STATUSES, 'unsupported']);
		expect(refs(filterRows(rows, { ...DEFAULT_QUERY, status: 'ocr' }))).toEqual([]);
	});
	it("labels text statuses with v5's wording: a row without text reads 'scan · none'", () => {
		expect(['extracted', 'ocr', 'none', 'pending', 'unsupported', ''].map(statusLabel)).toEqual(['extracted', 'ocr', 'scan · none', 'pending', 'unsupported', '—']);
	});
	it("previews an excerpt as v5 does: its first 140 code units and always an ellipsis; no excerpt, no preview", () => {
		expect(excerptPreview('short text')).toBe('short text…');
		const long = 'x'.repeat(139) + 'yz';
		expect(excerptPreview(long)).toBe('x'.repeat(139) + 'y…');
		expect(excerptPreview('')).toBe('');
	});
	it('round-trips the query through URL parameters, omitting defaults', () => {
		const q = { q: 'x y', bundle: 'Additional', type: '', status: 'none', sort: 'amount' as const, dir: -1 as const };
		expect(paramsFromQuery(q).toString()).toBe('q=x+y&bundle=Additional&status=none&sort=amount&dir=desc');
		expect(queryFromParams(paramsFromQuery(q))).toEqual(q);
		expect(paramsFromQuery(DEFAULT_QUERY).toString()).toBe('');
		expect(queryFromParams(new URLSearchParams('sort=__proto__&dir=up'))).toEqual(DEFAULT_QUERY);
	});
});
