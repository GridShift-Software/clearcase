// Advanced Search (GRS-14) on a synthetic corpus with literal expected refs: v5's predicates, reversed and malformed
// intervals rejected apart from a genuine empty result (BA-15), register order shared by the page and the export
// (BA-17), coverage counted from the rows (BA-08), and v5's action-item phrases.
import { beforeEach, describe, expect, it } from 'vitest';
import { toCSV } from '../../src/lib/components/csv.ts';
import { actionItems, coverage, exportRows, extractActionItems, invalidReason, paramsOf, queryFromParams, runSearch, searchRows, EMPTY, type SearchRow } from '../../src/lib/views/evidence/search.ts';
import { listRow, resetOrd } from './rows.ts';

let corpus: SearchRow[];
beforeEach(() => {
	resetOrd();
	const r = (ref: string, o: Partial<SearchRow>): SearchRow => ({ ...listRow(ref, o), cc: o.cc ?? '' });
	corpus = [
		r('OD-003', { date: '2001-03-01', docType: 'invoice', amount: '150.00', subject: 'Synthetic invoice three', excerpt: 'Please submit payment by 3 March. Thanks.' }),
		r('EM-0001', { date: '2001-01-15', docType: 'email', bundle: 'Correspondence', sender: 'alpha@example.test', to: 'beta@example.test', cc: 'gamma@example.test', subject: 'RE: synthetic' }),
		r('OD-001', { date: '', docType: 'invoice', amount: '', subject: 'Synthetic undated invoice', textStatus: 'none' }),
		r('VDM-001', { date: '2002-06-30', docType: 'report', bundle: 'Additional', amount: '75', excerpt: 'x'.repeat(130), textStatus: 'pending' }),
		r('OD-002', { date: '2001-02-01', docType: 'invoice', amount: '-20', subject: 'Synthetic credit note' }),
	];
});
const S = (o: Partial<typeof EMPTY>) => ({ ...EMPTY, ...o });
const refs = (o: Partial<typeof EMPTY>) => searchRows(corpus, S(o)).map((x) => x.ref);

describe('search predicates (v5 L497-507)', () => {
	it('keeps register order, with every imported bundle searchable', () => {
		expect(refs({})).toEqual(['OD-003', 'EM-0001', 'OD-001', 'VDM-001', 'OD-002']);
		expect(refs({ bundle: 'Additional' })).toEqual(['VDM-001']);
		expect(refs({ type: 'invoice' })).toEqual(['OD-003', 'OD-001', 'OD-002']);
		expect(refs({ bundle: 'Original', type: 'invoice', status: 'none' })).toEqual(['OD-001']);
	});
	it('matches text in filename, ref, subject, sender, to and excerpt, but not cc', () => {
		expect(refs({ q: 'INVOICE' })).toEqual(['OD-003', 'OD-001']);
		expect(refs({ q: 'beta@' })).toEqual(['EM-0001']);
		expect(refs({ q: 'gamma@' })).toEqual([]);
		expect(refs({ q: 'em-0001' })).toEqual(['EM-0001']);
	});
	it('matches the sender filter across sender, to and cc glued together (S-search-3, copied)', () => {
		expect(refs({ sender: 'gamma' })).toEqual(['EM-0001']);
		expect(refs({ sender: 'testbeta' })).toEqual(['EM-0001']); // the boundary between sender and to
	});
	it('excludes undated rows from a date interval and empty amounts from an amount interval', () => {
		expect(refs({ from: '2001-01-01' })).toEqual(['OD-003', 'EM-0001', 'VDM-001', 'OD-002']);
		expect(refs({ from: '2001-02-01', to: '2001-03-01' })).toEqual(['OD-003', 'OD-002']);
		expect(refs({ amin: '0' })).toEqual(['OD-003', 'VDM-001']);
		expect(refs({ amin: '-50', amax: '100' })).toEqual(['VDM-001', 'OD-002']);
	});
});

describe('BA-15: invalid intervals against genuine empty results', () => {
	it('rejects a reversed date interval and runs nothing', () => {
		const q = S({ from: '2001-03-01', to: '2001-01-01' });
		expect(invalidReason(q)).toBe('From date is after To date: the date interval is reversed.');
		expect(runSearch(corpus, q, true, 1)).toEqual({ kind: 'invalid', reason: 'From date is after To date: the date interval is reversed.' });
	});
	it('rejects a reversed amount interval and a bound that is not a number (S-search-5)', () => {
		expect(invalidReason(S({ amin: '100', amax: '5' }))).toBe('Amount min is greater than Amount max: the amount interval is reversed.');
		expect(invalidReason(S({ amin: 'abc' }))).toBe('Amount min is not a number.');
		expect(invalidReason(S({ amax: '1,000' }))).toBe('Amount max is not a number.');
	});
	it('shows a valid interval that matches nothing as an empty result, not an error', () => {
		const q = S({ from: '1999-01-01', to: '1999-12-31' });
		expect(invalidReason(q)).toBeNull();
		const r = runSearch(corpus, q, true, 1);
		expect(r).toMatchObject({ kind: 'results', page: { total: 0, from: 0, to: 0, slice: [] } });
		expect(invalidReason(S({ from: '2001-01-01', to: '2001-01-01', amin: '5', amax: '5' }))).toBeNull();
	});
	it('runs nothing before the first submitted search', () => {
		expect(runSearch(corpus, EMPTY, false, 1)).toEqual({ kind: 'idle' });
		expect(queryFromParams(new URLSearchParams(''))).toEqual({ query: EMPTY, submitted: false });
		expect(queryFromParams(new URLSearchParams(paramsOf(S({ q: 'x' })).toString()))).toEqual({ query: S({ q: 'x' }), submitted: true });
	});
});

describe('BA-17: page order, pagination and the export agree', () => {
	it('pages 50 results and exports every result in the same order with v5 columns', () => {
		const many: SearchRow[] = Array.from({ length: 120 }, (_, i) => ({ ...listRow(`SD-${String(1000 - i).slice(1)}`, { subject: `Synthetic ${i}` }), cc: '' }));
		const p1 = runSearch(many, S({ q: 'synthetic' }), true, 1), p3 = runSearch(many, S({ q: 'synthetic' }), true, 3);
		if (p1.kind !== 'results' || p3.kind !== 'results') throw new Error('expected results');
		expect([p1.page.from, p1.page.to, p1.page.pages, p3.page.from, p3.page.to]).toEqual([1, 50, 3, 101, 120]);
		const csv = toCSV(exportRows(searchRows(many, S({ q: 'synthetic' })))).split('\r\n');
		expect(csv[0]).toBe('ref,date,filename,subject,sender,doc_type,bundle,amount,text_status,url');
		expect(csv.slice(1).map((l) => l.split(',')[0])).toEqual([...p1.page.slice, ...(runSearch(many, S({ q: 'synthetic' }), true, 2) as { page: { slice: { ref: string }[] } }).page.slice, ...p3.page.slice].map((x) => x.ref));
	});
	it('previews 120 characters of the excerpt with v5 ellipsis (S-search-6, copied)', () => {
		const r = runSearch(corpus, S({ bundle: 'Additional' }), true, 1);
		if (r.kind !== 'results') throw new Error('expected results');
		expect(r.page.slice[0]!.excerpt).toBe(`${'x'.repeat(120)}…`);
	});
});

describe('BA-08 coverage and action items', () => {
	it('counts what search covers from the rows', () => {
		expect(coverage(corpus)).toEqual({ documents: 5, withExcerpt: 2, maxExcerpt: 130, extracted: 3, none: 1, pending: 1, other: 0 });
	});
	it('extracts v5 action-item phrases (checklist example)', () => {
		expect(extractActionItems('Please submit the form by 3 Feb. Thanks.')).toEqual(['Please submit the form by 3 Feb.']);
		expect(actionItems(corpus)).toEqual({ total: 1, shown: [{ ref: 'OD-003', date: '2001-03-01', t: 'Please submit payment by 3 March.' }] });
	});
});
