// Prescription model (GRS-16): v5's filter, pages and the shown-rows export (S-prescription_tab-1, -3, BA-17), and the
// BA-01 arithmetic on a synthetic fixture: invoice date + 3 years with 28/29 February and month ends, the as-of count
// against an explicit date, and the imported summary checked against the rows. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { arithmetic, asOfStatus, filterRows, paginate, paramsFrom, prescriptionCsv, queryFrom, riskOptions, summaryCheck, type PrescRow } from '../../src/lib/views/quantum/prescription';

const R = (ref: string, no: string, date: string, prescDate: string, risk = 'Relies on interruption'): PrescRow => ({ ref, no, date, prescDate, risk, url: '' });

describe('filters and pages (v5)', () => {
	const rows = [R('OD-1', 'INV10', '2081-01-31', '2084-01-31'), R('SD-2', 'INV20', '2082-02-28', '2085-02-28', 'Not yet due to prescribe')];
	it('the checklist example: text over "no ref", case-insensitive, untrimmed; exact risk', () => {
		expect(filterRows(rows, { q: 'inv1', risk: '' }).map((r) => r.ref)).toEqual(['OD-1']);
		expect(filterRows(rows, { q: '', risk: 'Not yet due to prescribe' }).map((r) => r.ref)).toEqual(['SD-2']);
		expect(filterRows(rows, { q: 'od-1 ', risk: '' })).toEqual([]);
		expect(filterRows(rows, { q: 'INV10 OD', risk: '' }).map((r) => r.ref)).toEqual(['OD-1']);
	});
	it('pages 80 rows at a time and clamps the page', () => {
		const many = Array.from({ length: 200 }, (_, i) => R(`OD-${i}`, `N${i}`, '', ''));
		expect(paginate(many, 1)).toMatchObject({ page: 1, pages: 3, from: 1, to: 80 });
		expect(paginate(many, 3)).toMatchObject({ from: 161, to: 200 });
		expect(paginate(many, 9).page).toBe(3);
		expect(paginate([], 1)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 });
	});
	it('keeps the filter and page in the URL query', () => {
		const q = queryFrom(new URLSearchParams('q=inv&risk=Not+yet+due+to+prescribe&page=2'));
		expect(q).toEqual({ q: 'inv', risk: 'Not yet due to prescribe', page: 2 });
		expect(queryFrom(new URLSearchParams(paramsFrom(q).toString()))).toEqual(q);
		expect(paramsFrom({ q: '', risk: '', page: 1 }).toString()).toBe('');
		expect(queryFrom(new URLSearchParams('page=-3')).page).toBe(1);
	});
	it('offers v5\'s risk options first, then any other imported risk', () => {
		expect(riskOptions([...rows, R('X-1', 'N', '', '', 'Low')])).toEqual(['Relies on interruption', 'Not yet due to prescribe', 'Low']);
	});
	it('exports the shown rows in order with v5\'s columns (url omitted)', () => {
		const csv = prescriptionCsv(filterRows(rows, { q: 'inv2', risk: '' })).split('\r\n');
		expect(csv).toEqual(['ref,no,date,prescDate,risk', 'SD-2,INV20,2082-02-28,2085-02-28,Not yet due to prescribe']);
	});
});

describe('BA-01 arithmetic (synthetic fixture)', () => {
	const fixture = [
		R('OD-1', 'A', '2088-02-29', '2091-02-28'), // leap day, target year not leap: 28 February
		R('OD-2', 'B', '2089-02-28', '2092-02-28'), // 28 February into a leap year stays 28 February
		R('OD-3', 'C', '2081-12-31', '2084-12-31'), // 31st of a month
		R('OD-4', 'D', '2082-01-31', '2085-01-31'),
		R('OD-5', 'E', '2088-02-29', '2091-03-01'), // a different rule (1 March): not counted as +3 years
		R('OD-6', 'F', '', ''), // no date
	];
	it('counts the dates that equal invoice date + 3 years, 29 February moved to 28 February', () => {
		const a = arithmetic(fixture, '2091-02-28');
		expect([a.rows, a.plusThree, a.leapInvoices, a.leapMovedTo28]).toEqual([6, 4, 2, 1]);
	});
	it('counts rows due on or before the as-of date (the boundary day counts as passed)', () => {
		expect(arithmetic(fixture, '2091-02-28').passed).toBe(3);
		expect(arithmetic(fixture, '2091-02-27').passed).toBe(2);
		expect(asOfStatus(fixture[0]!, '2091-02-28')).toBe('passed');
		expect(asOfStatus(fixture[0]!, '2091-02-27')).toBe('not-reached');
		expect(asOfStatus(fixture[5]!, '2091-02-28')).toBe('no-date');
	});
	it('is identical under the same fixed clock (no hidden clock read)', () => {
		expect(arithmetic(fixture, '2091-02-28')).toEqual(arithmetic(fixture, '2091-02-28'));
	});
});

describe('imported summary against the rows', () => {
	const rows = [R('OD-1', 'A', '', ''), R('OD-2', 'B', '', '', 'Not yet due to prescribe')];
	it('agrees when the totals match', () => {
		expect(summaryCheck({ awardDate: '', note: '', reliesOnInterruption: 1, total: 2 }, rows)).toEqual({ totalMatches: true, reliesMatches: true, reliesCount: 1 });
	});
	it('flags a summary that contradicts its own rows, without changing it', () => {
		const s = { awardDate: '', note: '', reliesOnInterruption: 2, total: 3 };
		expect(summaryCheck(s, rows)).toEqual({ totalMatches: false, reliesMatches: false, reliesCount: 1 });
		expect(s).toEqual({ awardDate: '', note: '', reliesOnInterruption: 2, total: 3 });
	});
});
