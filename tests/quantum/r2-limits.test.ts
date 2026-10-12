// CC-06 r2 regressions on the pure functions (GRS-16), synthetic inputs only: results too large to compute or show
// (D5, D6), the input bounds (D6, D11), years outside 1000 to 9999 (D7), payment entries (D8, D18), the South African
// as-of date (D9), Settlement after an overpayment (D10), URL values the controls cannot show (D12) and the thousands
// separator (a grouped amount that starts with 0 is R 500, not refused). Each repro is the lanes'
// (verify-findings.json); none may throw.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtR } from '../../src/lib/components/format';
import { dateProblem, daysBetween, isIsoDate, saDate } from '../../src/lib/calculations/dates';
import { centsText, floatToCents, MAX_SHOWN_CENTS, parseAmount } from '../../src/lib/calculations/money';
import { interestOutcome, type InterestInputs } from '../../src/lib/views/quantum/interest';
import { checkEntry } from '../../src/lib/views/quantum/payments';
import { arithmetic, asOfStatus, queryFrom, riskOptions, urlNotes, type PrescRow } from '../../src/lib/views/quantum/prescription';
import { claimPrefill, defaultInputs, settleOutcome } from '../../src/lib/views/quantum/settlement';

const I = (x: Partial<InterestInputs>): InterestInputs => ({ p: '1000', r: '10', m: 'Simple', from: '2093-01-10', to: '2094-01-10', ...x });
const C = 'Compound (monthly)';
const TOO_LARGE = /^The result is too large to show \(above R 9 999 999 999 999\.99\)/;

describe('D5: a compound result too large to compute is an error, never a throw', () => {
	it.each([
		['the pure call', { p: '1', r: '50', m: C, from: '2000-01-01', to: '2100-01-01' }],
		['one wrong digit in a year', { p: '1000', r: '10.5', m: C, from: '1025-03-01', to: '2026-03-01' }],
		['a large capital at 100%', { p: '1000000', r: '100', m: C, from: '1950-01-01', to: '2026-01-01' }],
		['the largest rate over the longest period', { p: '9999999999999.99', r: '100', m: C, from: '1000-01-01', to: '9999-12-31' }],
	])('%s', (_, x) => {
		const o = interestOutcome(I(x), 0n);
		expect(o.kpis).toBeNull();
		expect(o.errors.result).toMatch(TOO_LARGE);
	});
	it('floatToCents is null for a non-finite value and for exponent form, and exact just below 1e21', () => {
		expect([floatToCents(Infinity), floatToCents(NaN), floatToCents(1e21), floatToCents(-1e21)]).toEqual([null, null, null, null]);
		expect(floatToCents(1e20)).toBe(10n ** 22n);
	});
});

describe('D6: no figure beyond what fmtR shows exactly', () => {
	it('the lane\'s large compound case is refused, not shown with Capital + Interest != Total', () => {
		expect(interestOutcome(I({ p: '962684170613.76', r: '26.08', m: C, from: '2081-01-01', to: '2104-06-15' }), 0n).errors.result).toMatch(TOO_LARGE);
	});
	it('the cap\'s edge: R 9 999 999 999 999.99 shows; a total above it is refused', () => {
		const at = interestOutcome(I({ p: '9999999999999.99', r: '0', from: '2093-01-10', to: '2093-01-11' }), 0n);
		expect(at.kpis?.map((k) => k.value).slice(0, 3)).toEqual(['R 9 999 999 999 999.99', 'R 0.00', 'R 9 999 999 999 999.99']);
		// R 273.78 of interest a day on the capital at 0.000001 %
		expect(interestOutcome(I({ p: '9999999999999.99', r: '0.000001', from: '2093-01-10', to: '2093-01-11' }), 0n).errors.result).toMatch(TOO_LARGE);
	});
	it('fmtR is exact for every cent up to the cap (sampled), so nothing shown can be a cent off', () => {
		const exact = (c: bigint) => { const t = centsText(c < 0n ? -c : c); const [i, d] = t.split('.'); return `${c < 0n ? '-' : ''}R ${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${d}`; };
		let x = 0x2545f491n;
		for (let n = 0; n < 20000; n++) {
			x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
			const c = (x % (MAX_SHOWN_CENTS + 1n)) * (n % 2 ? -1n : 1n);
			expect(fmtR(centsText(c))).toBe(exact(c));
		}
		expect(fmtR(centsText(MAX_SHOWN_CENTS))).toBe('R 9 999 999 999 999.99');
	});
	it('amounts: 3 decimals and 14 digits of rand get a message naming the limit; nothing is rounded', () => {
		const e3 = parseAmount('1.005'), e14 = parseAmount('12345678901234');
		expect(e3.ok ? null : e3.error).toMatch(/^At most 2 decimals \(cents\): 1\.005 has 3\./);
		expect(e14.ok ? null : e14.error).toMatch(/^At most 13 digits of rand/);
		expect(parseAmount('9 999 999 999 999.99')).toEqual({ ok: true, value: MAX_SHOWN_CENTS });
	});
	it('each bound is shown and refused beyond: rate 100, probability 100, years 100, discount 100', () => {
		expect(interestOutcome(I({ r: '100' }), 0n).kpis).not.toBeNull();
		expect(interestOutcome(I({ r: '100.000001' }), 0n).errors.r).toBe('A rate is 0 to 100 % per annum (100.000001 is above 100).');
		expect(interestOutcome(I({ r: '999999999' }), 0n).errors.r).toMatch(/^A rate is 0 to 100/);
		const s = (x: Record<string, string>) => settleOutcome({ claim: '1000', p: '60', y: '3', d: '8', c: '0', ...x });
		expect([s({ p: '100' }), s({ y: '100' }), s({ d: '100' })].every((o) => o.kpis !== null)).toBe(true);
		expect(s({ y: '101' }).errors.y).toMatch(/^Years to recover are 0 to 100/);
		expect(s({ d: '100.5' }).errors.d).toMatch(/^A discount rate is 0 to 100/);
		expect(s({ p: '999999999' }).errors.p).toMatch(/^A probability is 0 to 100/);
		expect(s({ claim: '9999999999999.99', p: '100', y: '0', d: '0' }).kpis?.[1]?.value).toBe('R 9 999 999 999 999.99');
	});
});

describe('D7: years 1000 to 9999 only, days counted on the calendar', () => {
	it('counts every accepted year correctly', () => {
		expect(daysBetween('1000-01-01', '9999-12-31')).toBe(3287181);
		expect(daysBetween('1024-03-01', '2026-03-01')).toBe(365973);
		expect(daysBetween('1000-02-28', '1000-03-01')).toBe(1);
		expect(daysBetween('1600-02-28', '1600-03-01')).toBe(2);
		expect(daysBetween('2092-02-28', '2092-03-01')).toBe(2);
	});
	it.each(['0024-03-01', '0099-12-31', '0100-01-01', '0000-01-01', '0999-12-31', '10000-01-01'])('refuses %s with a message naming the field and the range', (d) => {
		expect(isIsoDate(d)).toBe(false);
		expect(dateProblem('From (mora)', d)).toBe(`From (mora): '${d}' is outside the accepted years. Enter a year from 1000 to 9999.`);
	});
	it('the interest view computes nothing on such a year and keeps the text (the repro: 0024 counted as 1924)', () => {
		const o = interestOutcome(I({ from: '0024-03-01', to: '2026-03-01' }), 0n);
		expect(o.kpis).toBeNull();
		expect(o.errors.from).toMatch(/'0024-03-01' is outside the accepted years/);
		expect(interestOutcome(I({ from: '0099-12-31', to: '0100-01-01' }), 0n).errors.to).toMatch(/'0100-01-01' is outside/);
		expect(interestOutcome(I({ m: 'Bogus' }), 0n).errors.m).toBe("Method 'Bogus' is not one this calculator offers: choose Simple or Compound (monthly).");
	});
	it('an imported date outside the range is shown as given with the "no valid date" status', () => {
		const row: PrescRow = { no: 'SYN', ref: 'OD-001', date: '0988-02-29', prescDate: '0991-02-28', risk: 'x', url: '' };
		expect(asOfStatus(row, '2026-10-08')).toBe('no-date');
	});
});

describe('D8 and D18: a payment entry is checked before the store sees it', () => {
	const e = (x: Record<string, string>) => checkEntry({ date: '', amount: '10.00', method: '', note: '', ...x });
	it.each(['2026-02-30', '=1+1', '0024-01-01'])('refuses the date %s, naming the field', (date) => {
		const r = e({ date });
		expect(r.ok ? null : [r.field, r.error.startsWith('Date: ')]).toEqual(['date', true]);
	});
	it('an empty date stays allowed; a real date is accepted', () => {
		expect(e({}).ok).toBe(true);
		expect(e({ date: '2089-03-31' }).ok).toBe(true);
	});
	it('refuses an over-long note or method with the limit, never as a store refusal', () => {
		const n = e({ note: 'x'.repeat(2001) }), m = e({ method: 'y'.repeat(201) }), big = e({ note: 'z'.repeat(70 * 1024) });
		expect(n.ok ? null : [n.field, n.error]).toEqual(['note', 'Note: at most 2 000 characters (this one has 2 001). Your text is kept; shorten it, then add it again.']);
		expect(m.ok ? null : m.field).toBe('method');
		expect(big.ok ? null : big.field).toBe('note');
		expect(e({ note: 'x'.repeat(2000), method: 'y'.repeat(200) }).ok).toBe(true);
	});
});

describe('D9: the as-of date is the South African calendar date', () => {
	it('either side of local midnight', () => {
		expect(saDate(new Date('2026-10-08T21:59:59Z'))).toBe('2026-10-08');
		expect(saDate(new Date('2026-10-08T22:00:00Z'))).toBe('2026-10-09');
		expect(saDate(new Date('2026-10-08T22:30:00Z'))).toBe('2026-10-09');
	});
	it.each(['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'])('whatever the host time zone (%s)', (tz) => {
		const src = resolve(import.meta.dirname, '../../src/lib/calculations/dates.ts');
		const out = execFileSync(process.execPath, ['-e', `import { saDate } from ${JSON.stringify(src)}; console.log([saDate(new Date('2026-10-08T21:59:59Z')), saDate(new Date('2026-10-08T22:00:00Z'))].join(' '))`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
		expect(out).toBe('2026-10-08 2026-10-09');
	});
	it('a row due the day before the South African date has passed, and one due that day has not', () => {
		const rows: PrescRow[] = [{ no: 'SYN', ref: 'OD-001', date: '2023-10-08', prescDate: '2026-10-08', risk: 'x', url: '' }];
		expect(arithmetic(rows, saDate(new Date('2026-10-08T22:30:00Z'))).passed).toBe(1);
	});
});

describe('D10 and D11: Settlement', () => {
	const DEF = { probability: 60, years: 3, discount: 8, cost: 1000 };
	it('the page\'s own prefill after an overpayment (a negative net) gives figures, as v5 computes a negative claim', () => {
		const o = settleOutcome(defaultInputs(claimPrefill(-15000n), DEF));
		expect(claimPrefill(-15000n)).toBe('-150');
		expect(o.errors).toEqual({});
		expect(o.kpis?.[1]).toEqual({ label: 'Base (p=60%)', value: '-R 1 071.44', sub: '' });
	});
	it('only the claim takes a minus: a negative cost stays refused; two minus signs are refused', () => {
		expect(settleOutcome({ claim: '1000', p: '60', y: '3', d: '8', c: '-5' }).errors.c).toMatch(/negative amount/);
		expect(settleOutcome({ claim: '--5', p: '60', y: '3', d: '8', c: '0' }).errors.claim).toMatch(/negative amount/);
	});
	it.each(['150', '101'])('a probability of %s is refused visibly, no figures', (p) => {
		const o = settleOutcome({ claim: '1000', p, y: '3', d: '8', c: '0' });
		expect([o.kpis, o.errors.p]).toEqual([null, `A probability is 0 to 100 (${p} is above 100).`]);
	});
});

describe('D12: a URL value the controls cannot show never filters silently', () => {
	const rows: PrescRow[] = [{ no: 'SYN1', ref: 'OD-001', date: '2081-01-01', prescDate: '2084-01-01', risk: 'Relies on interruption', url: '' }];
	const risks = riskOptions(rows);
	it('an unknown risk is ignored and named', () => {
		const p = new URLSearchParams('risk=Bogus');
		expect(queryFrom(p, risks).risk).toBe('');
		expect(urlNotes(p, risks, 1)).toEqual(["The risk filter 'Bogus' in the link matches no risk in this case and was ignored: every risk is shown."]);
	});
	it('a repeated key, a page that is not a number and a page beyond the last are named', () => {
		const p = new URLSearchParams('risk=Bogus&risk=Relies+on+interruption&page=x');
		expect(urlNotes(p, risks, 1)).toContain("The link gives 'risk' 2 times; only the first is used.");
		expect(urlNotes(p, risks, 1)).toContain("The page 'x' in the link is not a page number: page 1 is shown.");
		expect(urlNotes(new URLSearchParams('page=9'), risks, 2)).toEqual(['The link asks for page 9, but there are 2 pages: the last page is shown.']);
		expect(urlNotes(new URLSearchParams('risk=Relies+on+interruption&q=SYN'), risks, 1)).toEqual([]);
	});
});

describe('a comma or space between thousands is a thousands separator (PO decision, 11 October)', () => {
	it.each([['0,500', 50000n], ['1,500', 150000n], ['R 0,500', 50000n], ['0 500', 50000n], ['1 000', 100000n], ['0.50', 50n], ['0500', 50000n]])('%s', (t, cents) => {
		const r = parseAmount(t);
		expect(r.ok ? r.value : r.error).toBe(cents);
	});
	it('a comma before one or two digits is still refused as a comma decimal', () => {
		expect(parseAmount('0,50').ok).toBe(false);
		expect(parseAmount('1 000,50').ok).toBe(false);
	});
});
