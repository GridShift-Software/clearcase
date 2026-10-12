// Interest, day count, settlement and calendar arithmetic (GRS-16): the R100 literal, the expected examples
// interest-simple and interest-compound, leap dates and month ends, and the settlement checklist examples.
import { describe, expect, it } from 'vitest';
import { fmtR } from '../../src/lib/components/format';
import { addYears, daysBetween, isIsoDate, utcDate } from '../../src/lib/calculations/dates';
import { computeInterest, settlement, simpleInterestDays, simpleInterestYears, yearsLabel } from '../../src/lib/calculations/interest';
import { centsText, parseAmount, parseDecimal } from '../../src/lib/calculations/money';

const amt = (t: string) => { const r = parseAmount(t); if (!r.ok) throw new Error(r.error); return r.value; };
const rate = (t: string) => { const r = parseDecimal(t); if (!r.ok) throw new Error(r.error); return r.value; };
const R = (c: bigint) => fmtR(centsText(c));

describe('the R100 literal: R1,000 at 10% simple interest for one year', () => {
	it('is exactly R100 for a period of one year', () => {
		expect(R(simpleInterestYears(amt('R1,000'), rate('10'), 1))).toBe('R 100.00');
		expect(R(simpleInterestYears(amt('1 000'), rate('10'), 1))).toBe('R 100.00');
	});
	it('is R 99.93 for a dated year of 365 days and R 100.21 for 366 days on the Actual/365.25 basis', () => {
		expect(daysBetween('2093-01-10', '2094-01-10')).toBe(365);
		expect(daysBetween('2091-03-01', '2092-03-01')).toBe(366);
		expect(R(simpleInterestDays(amt('R1,000'), rate('10'), 365))).toBe('R 99.93');
		expect(R(simpleInterestDays(amt('R1,000'), rate('10'), 366))).toBe('R 100.21');
	});
});

describe('the expected examples', () => {
	it('interest-simple: 100000 at 10, Simple, 2004-02-03 to 2005-02-03', () => {
		const days = daysBetween('2004-02-03', '2005-02-03')!;
		expect(days).toBe(366);
		const r = computeInterest(amt('100000'), rate('10'), 'Simple', days);
		expect([R(r.capital), r.yearsLabel, R(r.interest), R(r.total)]).toEqual(['R 100 000.00', '1.00', 'R 10 020.53', 'R 110 020.53']);
	});
	it('interest-compound: as above, Compound (monthly)', () => {
		const r = computeInterest(amt('100000'), rate('10'), 'Compound (monthly)', 366);
		expect([R(r.interest), R(r.total)]).toEqual(['R 10 493.90', 'R 110 493.90']);
	});
	it('the checklist\'s three-year examples', () => {
		const days = daysBetween('2004-02-03', '2007-02-03')!;
		expect(days).toBe(1096);
		const s = computeInterest(amt('100000'), rate('10.5'), 'Simple', days);
		expect([s.yearsLabel, R(s.interest), R(s.total)]).toEqual(['3.00', 'R 31 507.19', 'R 131 507.19']);
		const c = computeInterest(amt('100000'), rate('10.5'), 'Compound (monthly)', days);
		expect([R(c.interest), R(c.total)]).toEqual(['R 36 848.11', 'R 136 848.11']);
	});
	it('a capital typed with the app\'s separators is the full amount (S-interest_calc_tab-1)', () => {
		expect(R(computeInterest(amt('100 000'), rate('10'), 'Simple', 366).total)).toBe('R 110 020.53');
	});
});

describe('zero and degenerate inputs', () => {
	it('zero capital, zero rate and a zero-day period give zero interest', () => {
		expect(computeInterest(0n, rate('10'), 'Simple', 366).interest).toBe(0n);
		expect(computeInterest(amt('1000'), rate('0'), 'Compound (monthly)', 366).interest).toBe(0n);
		const z = computeInterest(amt('1000'), rate('10'), 'Simple', 0);
		expect([z.interest, z.yearsLabel]).toEqual([0n, '0']);
	});
	it('labels the period as v5 does', () => {
		expect(yearsLabel(366)).toBe('1.00');
		expect(yearsLabel(0)).toBe('0');
	});
});

describe('calendar dates: leap days and month ends', () => {
	it('counts days on the calendar, independent of time zone', () => {
		expect(daysBetween('2092-02-28', '2092-03-01')).toBe(2);
		expect(daysBetween('2093-02-28', '2093-03-01')).toBe(1);
		expect(daysBetween('2093-03-27', '2093-03-29')).toBe(2);
		expect(daysBetween('2005-02-03', '2004-02-03')).toBe(-366);
		expect(daysBetween('2004-02-30', '2005-01-01')).toBeNull();
		expect(daysBetween('', '2005-01-01')).toBeNull();
	});
	it('adds years: 29 February becomes 28 February when the target year is not leap', () => {
		expect(addYears('2088-02-29', 3)).toBe('2091-02-28');
		expect(addYears('2088-02-29', 4)).toBe('2092-02-29');
		expect(addYears('2089-02-28', 3)).toBe('2092-02-28');
		expect(addYears('2001-02-03', 3)).toBe('2004-02-03');
	});
	it('keeps the 31st of a month and other month ends', () => {
		expect(addYears('2081-12-31', 3)).toBe('2084-12-31');
		expect(addYears('2082-01-31', 3)).toBe('2085-01-31');
		expect(addYears('2082-04-30', 3)).toBe('2085-04-30');
		expect(addYears('2082-02-31', 3)).toBeNull();
	});
	it('validates calendar dates', () => {
		expect(isIsoDate('2092-02-29')).toBe(true);
		expect(isIsoDate('2093-02-29')).toBe(false);
		expect(isIsoDate('2100-02-29')).toBe(false);
		expect(isIsoDate('2000-02-29')).toBe(true);
		expect(isIsoDate('2093-04-31')).toBe(false);
	});
	it('takes the as-of date of an instant in UTC', () => {
		expect(utcDate(new Date('2026-10-08T09:00:00Z'))).toBe('2026-10-08');
		expect(utcDate(new Date('2026-10-08T23:30:00-02:00'))).toBe('2026-10-09');
	});
});

describe('settlement (checklist examples)', () => {
	const run = (claim: string, p: number, y: number, d: number, c: string) => { const s = settlement(amt(claim), p, y, d, amt(c)); return [R(s.pessimistic.cents), R(s.base.cents), R(s.optimistic.cents)]; };
	it('claim 1000000, p 70, 2 years at 10%, cost 100000', () => {
		expect(run('1000000', 70, 2, 10, '100000')).toEqual(['R 271 900.83', 'R 478 512.40', 'R 602 479.34']);
	});
	it('clamps the optimistic probability at 100 and the pessimistic at 0', () => {
		expect(run('1000000', 95, 2, 10, '100000')[2]).toBe('R 726 446.28');
		expect(run('1000000', 10, 2, 10, '100000')[0]).toBe('-R 100 000.00');
	});
	it('does not discount over zero years', () => {
		expect(run('1000000', 50, 0, 10, '0')[1]).toBe('R 500 000.00');
	});
});
