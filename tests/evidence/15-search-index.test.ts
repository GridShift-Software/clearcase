// Sprint ticket 15: search over the published index's rows. The page's data is the same for local and hosted rows, the
// index row keeps what search reads, and a row with nothing but an excerpt matches as before.
import { beforeEach, describe, expect, it } from 'vitest';
import { exportRows, indexRow, runSearch, searchOptions, searchPage, searchRows, EMPTY, type SearchInput, type SearchRow } from '../../src/lib/views/evidence/search.ts';
import { listRow, resetOrd } from './rows.ts';

let rows: SearchInput[];
beforeEach(() => {
	resetOrd();
	const r = (ref: string, o: Partial<SearchRow>) => indexRow({ ...listRow(ref, o), cc: o.cc ?? '' });
	rows = [
		r('SY-001', { filename: 'Lease schedule.pdf', subject: 'Synthetic lease', sender: 'lessor@example.test', excerpt: 'Rent is payable monthly.' }),
		r('SY-002', { filename: 'Quarterly note.pdf', subject: 'Quarterly note', sender: 'agent@example.test', to: 'lessee@example.test', cc: 'copy@example.test', excerpt: '' }),
		r('SY-003', { filename: 'Scan.pdf', subject: '', sender: '', excerpt: 'Only an excerpt mentions the zebra clause.', textStatus: 'none' }),
	];
});
const refs = (q: string) => searchRows(rows, { ...EMPTY, q }).map((x) => x.ref);
const p = (s: string) => new URLSearchParams(s);

describe('15 search index rows', () => {
	it('keeps the index fields and drops the rest of the list row', () => {
		const full: SearchRow = { ...listRow('SY-009', { subject: 'S', filename: 'f.pdf', amount: '12.50', url: './x.pdf' }), cc: 'c@example.test' };
		expect(Object.keys(indexRow(full)).sort()).toEqual(['amount', 'bundle', 'cc', 'date', 'docType', 'excerpt', 'file', 'filename', 'ref', 'sender', 'subject', 'textStatus', 'to']);
		expect(indexRow(full)).toMatchObject({ ref: 'SY-009', cc: 'c@example.test', amount: '12.50' });
	});

	it('matches ref, file name, subject, sender and excerpt, case-insensitively', () => {
		expect(refs('sy-002')).toEqual(['SY-002']);
		expect(refs('LEASE SCHEDULE')).toEqual(['SY-001']);
		expect(refs('quarterly')).toEqual(['SY-002']);
		expect(refs('agent@example')).toEqual(['SY-002']);
		expect(refs('zebra')).toEqual(['SY-003']);
		expect(refs('copy@')).toEqual([]);
	});

	it('runs over rows whose only searchable text is the excerpt, as before', () => {
		const excerptOnly = [indexRow({ ...listRow('SY-100', { filename: '', excerpt: 'alpha beta' }), cc: '' })];
		const r = runSearch(excerptOnly, { ...EMPTY, q: 'beta' }, true, 1);
		expect(r.kind === 'results' && r.page.slice.map((x) => x.ref)).toEqual(['SY-100']);
	});

	it('builds the page data from the URL alone: idle, results, invalid and action items', () => {
		expect(searchPage(rows, p('')).result).toEqual({ kind: 'idle' });
		const hit = searchPage(rows, p('q=lease'));
		expect(hit.submitted).toBe(true);
		expect(hit.result?.kind === 'results' && hit.result.page.slice.map((x) => x.ref)).toEqual(['SY-001']);
		expect(searchPage(rows, p('q=x&from=2001-13-01')).result).toMatchObject({ kind: 'invalid' });
		expect(searchPage(rows, p('actions=1')).actions).toMatchObject({ total: 0 });
		expect(hit.coverage).toMatchObject({ documents: 3, withExcerpt: 2, none: 1 });
		expect(hit.options.statuses).toEqual(['extracted', 'ocr', 'none', 'pending']);
	});

	it('pages 50 to a page and says so when the page is out of range', () => {
		const many = Array.from({ length: 120 }, (_, i) => indexRow({ ...listRow(`MN-${String(i).padStart(3, '0')}`, { subject: 'many' }), cc: '' }));
		const page2 = searchPage(many, p('q=many&page=2'));
		expect(page2.result?.kind === 'results' && [page2.result.page.from, page2.result.page.to, page2.result.page.pages]).toEqual([51, 100, 3]);
		expect(searchPage(many, p('q=many&page=9')).pageNotice).toMatch(/does not exist/);
	});

	it('exports the rows with the url the caller gives them', () => {
		const out = exportRows(rows.slice(0, 1).map((r) => ({ ...r, url: '/cases/c/v/rv/doc/SY-001' })));
		expect(out[1]).toEqual(['SY-001', '', 'Lease schedule.pdf', 'Synthetic lease', 'lessor@example.test', 'other', 'Original', '', 'extracted', '/cases/c/v/rv/doc/SY-001']);
	});

	it('offers the bundles in first-seen order and the types sorted', () => {
		const o = searchOptions([{ bundle: 'B', docType: 'z', textStatus: 'extracted' }, { bundle: '', docType: 'a', textStatus: 'odd' }, { bundle: 'B', docType: 'a', textStatus: 'extracted' }]);
		expect(o.bundles).toEqual([{ value: 'B', label: 'B' }, { value: '~', label: '(no bundle)' }]);
		expect(o.types).toEqual(['a', 'z']);
		expect(o.statuses).toEqual(['extracted', 'ocr', 'none', 'pending', 'odd']);
	});
});
