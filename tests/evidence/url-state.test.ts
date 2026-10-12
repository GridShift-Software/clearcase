// URL state the controls cannot show (GRS-14, CC-04 r2): Search refuses, with a message and never as a genuine empty
// result, a bundle, type or status that is not an option, a date bound that is not YYYY-MM-DD or not a calendar day,
// and a Text or Sender value longer than the cap (D3, D13), reporting every invalid interval at once (D12). Documents
// says when it does not apply a URL value (unknown bundle, long filter, a page it does not show). The empty-named
// bundle has its own value in both views (D4). Synthetic rows.
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT, bundleLabel, bundleParam, pageNotice } from '../../src/lib/views/evidence/common.ts';
import { documentsModel } from '../../src/lib/views/evidence/documents.ts';
import { EMPTY, invalidReason, runSearch, searchOptions, searchRows, type SearchRow } from '../../src/lib/views/evidence/search.ts';
import { listRow, resetOrd } from './rows.ts';

let rows: SearchRow[];
const r = (ref: string, o: Partial<SearchRow>): SearchRow => ({ ...listRow(ref, o), cc: o.cc ?? '' });
beforeEach(() => {
	resetOrd();
	rows = [
		r('SYN-1', { date: '2091-01-07', docType: 'letter' }),
		r('SYN-2', { date: '2091-01-09', docType: 'letter', bundle: 'Additional' }),
		r('SYN-3', { date: '', docType: 'invoice' }),
	];
});
const S = (o: Partial<typeof EMPTY>) => ({ ...EMPTY, ...o });
const run = (o: Partial<typeof EMPTY>) => runSearch(rows, S(o), true, 1);

describe('D3: Search refuses URL values its form cannot show', () => {
	it.each([
		['a bundle no row carries', { bundle: 'Pleadings' }, /^Bundle “Pleadings” is not in this results version\./],
		['a type no row carries', { type: 'Invoice' }, /^Type “Invoice” is not in this results version\./],
		['a text status that is not an option', { status: 'scanned' }, /^Text status “scanned” is not one of the options\./],
		['from=abc', { from: 'abc' }, /^From date “abc” is not a date \(YYYY-MM-DD\)\./],
		['a slashed date', { from: '07/01/2024' }, /^From date “07\/01\/2024” is not a date/],
		['from=2091-13-45', { from: '2091-13-45' }, /^From date 2091-13-45 is not a day in the calendar\./],
		['from=to=2091-02-30', { from: '2091-02-30', to: '2091-02-30' }, /^From date 2091-02-30 is not a day in the calendar\. To date 2091-02-30 is not a day in the calendar\.$/],
		['to=notadate', { to: 'notadate' }, /^To date “notadate” is not a date/],
	])('%s', (_, q, why) => {
		const res = run(q);
		expect(res.kind).toBe('invalid');
		expect(res.kind === 'invalid' && res.reason).toMatch(why);
	});
	it('names the malformed bound of an unpadded date, not a reversed interval', () => {
		expect(invalidReason(S({ from: '2091-1-5', to: '2091-01-10' }))).toBe('From date “2091-1-5” is not a date (YYYY-MM-DD).');
	});
	it('still searches valid bounds, a real leap day and every listed option', () => {
		expect(run({ from: '2091-01-08' })).toMatchObject({ kind: 'results', page: { total: 1 } });
		expect(run({ from: '2092-02-29', to: '2092-02-29' })).toMatchObject({ kind: 'results', page: { total: 0 } });
		expect(run({ bundle: 'Additional', type: 'letter', status: 'pending' })).toMatchObject({ kind: 'results', page: { total: 0 } });
		expect(run({ bundle: 'Additional', type: 'letter' })).toMatchObject({ kind: 'results', page: { total: 1 } });
	});
});

describe('D12: every invalid interval is reported at once', () => {
	it('reports a reversed date and a reversed amount interval together', () => {
		expect(invalidReason(S({ from: '2093-01-01', to: '2092-01-01', amin: '10', amax: '1' }))).toBe('From date is after To date: the date interval is reversed. Amount min is greater than Amount max: the amount interval is reversed.');
	});
});

describe(`D13: Text and Sender are capped at ${MAX_TEXT} characters`, () => {
	it('refuses a longer value from the URL with a message, and accepts the cap', () => {
		expect(run({ q: 'x'.repeat(MAX_TEXT + 1) })).toEqual({ kind: 'invalid', reason: `Text is longer than ${MAX_TEXT} characters.` });
		expect(run({ sender: 'x'.repeat(MAX_TEXT + 1) })).toEqual({ kind: 'invalid', reason: `Sender contains is longer than ${MAX_TEXT} characters.` });
		expect(run({ q: 'x'.repeat(MAX_TEXT) })).toMatchObject({ kind: 'results' });
	});
	it('does not apply a Documents filter longer than the cap, and says so', () => {
		const m = documentsModel(rows, { bundle: null, q: 'zz'.repeat(MAX_TEXT), page: null });
		expect(m).toMatchObject({ filterTooLong: true, page: { total: 2 } });
		expect(documentsModel(rows, { bundle: null, q: 'zz', page: null })).toMatchObject({ filterTooLong: false, page: { total: 0 } });
	});
});

describe('D3: Documents says which URL page it does not show', () => {
	it('names a malformed or out-of-range page and shows page 1 or the last page', () => {
		const many = Array.from({ length: 70 }, (_, i) => listRow(`SYN-${100 + i}`));
		expect(documentsModel(many, { bundle: null, q: '', page: 'abc' })).toMatchObject({ page: { page: 1 }, pageNotice: 'The requested page “abc” is not a page number; page 1 is shown.' });
		expect(documentsModel(many, { bundle: null, q: '', page: '9' })).toMatchObject({ page: { page: 2 }, pageNotice: 'Page 9 does not exist here; page 2 of 2 is shown.' });
		expect(documentsModel(many, { bundle: null, q: '', page: '2' }).pageNotice).toBeNull();
		expect(documentsModel(many, { bundle: null, q: '', page: null }).pageNotice).toBeNull();
		expect(pageNotice('0', { page: 1, pages: 1 })).toMatch(/is not a page number/);
	});
});

describe('D4: the empty-named bundle is selectable in Documents and Search', () => {
	const named = (names: string[]) => names.map((b, i) => r(`SYN-${i}`, { bundle: b }));
	it('encodes the empty name as `~`, escapes names that start with `~`, and labels it "(no bundle)"', () => {
		const names = ['', '~', '~x', 'x', '(no bundle)', '~~'];
		const values = names.map(bundleParam);
		expect(values).toEqual(['~', '~~', '~~x', 'x', '(no bundle)', '~~~']);
		expect(new Set(values).size).toBe(names.length);
		expect(values).not.toContain('');
		expect(bundleLabel('')).toBe('(no bundle)');
		expect(bundleLabel('Original')).toBe('Original');
	});
	it('shows the empty bundle in Documents by its value, apart from the first bundle', () => {
		const rs = named(['Original', '', '']);
		const m = documentsModel(rs, { bundle: '~', q: '', page: null });
		expect(m).toMatchObject({ bundle: '', unknownBundle: false, page: { total: 2 } });
		expect(m.bundles).toEqual([{ name: 'Original', value: 'Original', label: 'Original', count: 1 }, { name: '', value: '~', label: '(no bundle)', count: 2 }]);
		// a bundle named like the label or like the sentinel keeps its own value
		const odd = named(['', '(no bundle)', '~']);
		expect(documentsModel(odd, { bundle: '(no bundle)', q: '', page: null }).page.slice.map((x) => x.ref)).toEqual(['SYN-1']);
		expect(documentsModel(odd, { bundle: '~~', q: '', page: null }).page.slice.map((x) => x.ref)).toEqual(['SYN-2']);
		expect(documentsModel(odd, { bundle: '~', q: '', page: null }).page.slice.map((x) => x.ref)).toEqual(['SYN-0']);
	});
	it('offers the empty bundle in Search as its own option, not as All', () => {
		const rs = named(['Original', '', '~']);
		expect(searchOptions(rs).bundles).toEqual([{ value: 'Original', label: 'Original' }, { value: '~', label: '(no bundle)' }, { value: '~~', label: '~' }]);
		expect(searchRows(rs, S({ bundle: '~' })).map((x) => x.ref)).toEqual(['SYN-1']);
		expect(searchRows(rs, S({ bundle: '~~' })).map((x) => x.ref)).toEqual(['SYN-2']);
		expect(searchRows(rs, S({ bundle: '' })).map((x) => x.ref)).toEqual(['SYN-0', 'SYN-1', 'SYN-2']);
	});
});
