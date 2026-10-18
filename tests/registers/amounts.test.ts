// The registers' amount grammar and exact arithmetic (GRS-17, CC-07 r2, D10): amounts and rates in integer cents,
// hours in hundredths, products and sums exact and rounded once half-up; v5's parse (fmtR strip, parseFloat) refused
// visibly (S-disbursements_tab-1, S-timesheet_tab-3). Synthetic values only.
process.env.TZ = 'UTC';
import { describe, expect, it } from 'vitest';
import { centsText, divRound } from '../../src/lib/calculations/money.ts';
import { BOUND, hoursTile, parseAmount, valueCents } from '../../src/lib/views/registers/amounts';
import { REGISTERS } from '../../src/lib/views/registers/defs';
import { cellText, entryFrom, invalidReason, timesheetValue, unbilledHours, unbilledTime } from '../../src/lib/views/registers/logic';

const ok = (units: bigint) => ({ kind: 'ok', units });
const bad = (s: string, k: Parameters<typeof parseAmount>[1] = 'signed-money') => parseAmount(s, k).kind === 'bad';

describe('the amount grammar', () => {
	it("parses digits, the app's own 'R 1 000.00' form and groups of three, into cents", () => {
		expect(parseAmount('1500', 'signed-money')).toEqual(ok(150000n));
		expect(parseAmount('R 1 000.00', 'signed-money')).toEqual(ok(100000n));
		expect(parseAmount('R1000.5', 'signed-money')).toEqual(ok(100050n));
		expect(parseAmount('1,500.25', 'signed-money')).toEqual(ok(150025n));
		// decided by the product owner on 11 October 2026: '1,500' is R 1 500.00 for an amount or a rate, refused for
		// hours, and a disbursement may be a credit (negative), as in v5
		expect([parseAmount('1,500', 'signed-money'), parseAmount('1,500', 'rate')]).toEqual([ok(150000n), ok(150000n)]);
		expect(parseAmount('1,500', 'hours')).toMatchObject({ kind: 'bad' });
		expect(parseAmount('-150.00', 'signed-money')).toEqual(ok(-15000n));
		expect(parseAmount(' 99.95 ', 'rate')).toEqual(ok(9995n));
		expect(parseAmount('', 'signed-money')).toEqual({ kind: 'empty' });
		expect(parseAmount('2.5', 'hours')).toEqual(ok(250n));
	});
	it('accepts one leading minus on a disbursement (a credit) and refuses it on hours and rates', () => {
		expect(parseAmount('-150.00', 'signed-money')).toEqual(ok(-15000n));
		expect(parseAmount('-R 5', 'signed-money')).toEqual(ok(-500n));
		expect(parseAmount('-1', 'rate')).toMatchObject({ kind: 'bad', why: 'cannot be negative' });
		expect(parseAmount('-1', 'hours')).toMatchObject({ kind: 'bad', why: 'cannot be negative' });
		expect(bad('--1')).toBe(true);
	});
	it('refuses a decimal comma, other separators, U+2212, an exponent, more decimals and other text, saying why', () => {
		expect(parseAmount('1 500,50', 'signed-money')).toMatchObject({ kind: 'bad', why: expect.stringMatching(/decimal comma/) });
		expect(parseAmount('2,5', 'hours')).toMatchObject({ kind: 'bad', why: expect.stringMatching(/decimal comma/) });
		expect(parseAmount('−150.00', 'signed-money')).toMatchObject({ kind: 'bad' });
		expect(parseAmount('1e3', 'signed-money')).toMatchObject({ kind: 'bad', why: expect.stringMatching(/exponent/) });
		expect(parseAmount('1e11', 'hours')).toMatchObject({ kind: 'bad', why: expect.stringMatching(/exponent/) });
		expect(parseAmount('1.005', 'signed-money')).toMatchObject({ kind: 'bad', why: expect.stringMatching(/2 decimals/) });
		for (const s of ['1 2', '1_000', '1.000.000', '1 000,000', '1 000', 'Synthetic entry 1', 'R', '.5', '1.', '12,34,567']) expect([s, bad(s)]).toEqual([s, true]);
	});
	it('bounds every size so products and totals stay inside fmtR\'s exact range, and refuses larger input visibly', () => {
		expect(parseAmount('999 999 999 999.99', 'signed-money')).toEqual(ok(99999999999999n));
		expect(parseAmount('1 000 000 000 000', 'signed-money')).toMatchObject({ kind: 'bad', why: 'must be below R 1 000 000 000 000' });
		expect(parseAmount('9999999.99', 'rate')).toEqual(ok(999999999n));
		expect(parseAmount('10000000', 'rate')).toMatchObject({ kind: 'bad' });
		expect(parseAmount('9999.99', 'hours')).toEqual(ok(999999n));
		expect(parseAmount('10000', 'hours')).toMatchObject({ kind: 'bad', why: 'must be below 10 000' });
		expect(BOUND).toEqual({ 'signed-money': 12, rate: 7, hours: 4 });
		// the largest Value: 9 999.99 h × R 9 999 999.99, exact to the cent and formatted exactly
		expect(timesheetValue({ hours: '9999.99', rate: '9999999.99' })).toBe('R 99 999 899 900.00');
	});
});

describe('exact arithmetic, rounded once half-up', () => {
	it('rounds a half cent up (v5 and toFixed round 370.335 and 1.005 down)', () => {
		expect(valueCents('0.3', '1234.45')).toBe(37034n);
		expect(timesheetValue({ hours: '0.3', rate: '1234.45' })).toBe('R 370.34');
		expect(timesheetValue({ hours: '0.5', rate: '2.01' })).toBe('R 1.01');
		expect(timesheetValue({ hours: '2.5', rate: '1.07' })).toBe('R 2.68');
		expect(divRound(-5n, 10n)).toBe(-1n);
		expect(centsText(-15005n)).toBe('-150.05');
		expect(centsText(5n)).toBe('0.05');
	});
	it("shows the brief's synthetic inputs exactly or refuses them (no R 150 050.00, R 13.00, R 1.50 or R 1e+21.undefined)", () => {
		const d = REGISTERS.disbursements_tab, t = REGISTERS.timesheet_tab;
		expect(invalidReason(d, entryFrom(d, { amount: '1 500,50' }))).toMatch(/^Amount \(R\) uses a decimal comma/);
		expect(invalidReason(d, entryFrom(d, { amount: '−150.00' }))).toMatch(/^Amount \(R\) /);
		expect(invalidReason(d, entryFrom(d, { amount: '1e3' }))).toMatch(/exponent/);
		expect(invalidReason(t, entryFrom(t, { hours: '1.5', rate: '1 200' }))).toBeNull();
		expect(timesheetValue({ hours: '1.5', rate: '1 200' })).toBe('R 1 800.00');
		expect(invalidReason(t, entryFrom(t, { hours: '2,5' }))).toMatch(/^Hours uses a decimal comma/);
		expect(invalidReason(t, entryFrom(t, { hours: '1e11', rate: '1e10' }))).toMatch(/exponent/);
		expect(invalidReason(t, entryFrom(t, { rate: '-100' }))).toMatch(/^Rate\/h \(R\) cannot be negative/);
		expect(cellText('money', { amount: '-150.00' }, 'amount')).toBe('-R 150.00');
		expect(cellText('money', { amount: 'R 1 000.00' }, 'amount')).toBe('R 1 000.00');
		expect(cellText('money', { amount: '' }, 'amount')).toBe('');
	});
	it('shows a stored value that does not parse as typed and leaves it out of every total (never coerced)', () => {
		expect(cellText('money', { amount: '1 500,50' }, 'amount')).toBe('1 500,50');
		expect(timesheetValue({ hours: '2,5', rate: '100' })).toBe('');
		const rows = [{ hours: '2,5', billed: '' }, { hours: '1.25', billed: 'no' }, { hours: '0.3', billed: '' }, { hours: '7', billed: 'yes' }].map((v, i) => ({ rowId: String(i), values: v }));
		expect(unbilledTime(rows)).toEqual({ value: '1.6 h', uncounted: 1 });
		// 0.25 + 0.1 + 1.0 + 0.1 = 1.45, one decimal half-up: 1.5 (a float sum gives 1.4500000000000002 or less)
		expect(unbilledHours(['0.25', '0.1', '1', '0.1'].map((h, i) => ({ rowId: String(i), values: { hours: h, billed: '' } })))).toBe('1.5 h');
		expect(hoursTile(5n)).toBe('0.1');
	});
});

describe('register strings preserved with shared money primitives', () => {
	it('keeps a signed disbursement credit', () => {
		expect(cellText('money', { amount: '-150.05' }, 'amount')).toBe('-R 150.05');
	});
	it('keeps the refusal of a rate with more than two decimals', () => {
		const t = REGISTERS.timesheet_tab;
		expect(invalidReason(t, entryFrom(t, { hours: '1.5', rate: '1200.125' }))).toBe('Rate/h (R) can have at most 2 decimals. Nothing was saved; your input is kept.');
		expect(timesheetValue({ hours: '1.5', rate: '1200.125' })).toBe('');
	});
	it('keeps the rounded hours tile', () => {
		expect(unbilledHours([{ rowId: 'hours', values: { hours: '1.55', billed: '' } }])).toBe('1.6 h');
	});
});
