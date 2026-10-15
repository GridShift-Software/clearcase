import { centsToNumber, divRound, floatToCents, type Decimal } from './money.ts';

/** Actual/365.25 as an exact fraction: years = days * 4 / 1461. */
const YEAR_NUM = 4n;
const YEAR_DEN = 1461n;

export const simpleInterestDays = (principal: bigint, rate: Decimal, days: number): bigint =>
	divRound(principal * rate.num * BigInt(days) * YEAR_NUM, rate.den * 100n * YEAR_DEN);

export const simpleInterestYears = (principal: bigint, rate: Decimal, years: number): bigint =>
	divRound(principal * rate.num * BigInt(years), rate.den * 100n);

/**
 * v5's compound (monthly) total as a double: P·(1 + r/100/12)^(12·days/365.25), with v5's operation order
 * (years = days/365.25, months = years·12), so both engines evaluate the same expression. Rounded by the caller.
 */
export function compoundTotal(principal: bigint, rate: Decimal, days: number): number {
	const years = days / 365.25;
	const months = years * 12;
	return centsToNumber(principal) * Math.pow(1 + rate.value / 100 / 12, months);
}

/** v5's period label: the years to two decimals when positive, else '0'. */
export const yearsLabel = (days: number) => { const years = days / 365.25; return years > 0 ? years.toFixed(2) : '0'; };

export type Method = 'Simple' | 'Compound (monthly)';
export const METHODS: readonly Method[] = ['Simple', 'Compound (monthly)'];

export interface InterestResult { capital: bigint; interest: bigint; total: bigint; days: number; yearsLabel: string }

export function computeInterest(principal: bigint, rate: Decimal, method: Method, days: number): InterestResult {
	if (method === 'Compound (monthly)') {
		const total = floatToCents(compoundTotal(principal, rate, days));
		if (total === null) throw new RangeError('compound interest overflowed');
		return { capital: principal, interest: total - principal, total, days, yearsLabel: yearsLabel(days) };
	}
	const interest = simpleInterestDays(principal, rate, days);
	return { capital: principal, interest, total: principal + interest, days, yearsLabel: yearsLabel(days) };
}

export interface Scenario { probability: number; cents: bigint }
export interface SettlementResult { pessimistic: Scenario; base: Scenario; optimistic: Scenario }

/**
 * v5's settlement model: ev(p) = claim·p/100 / (1 + d/100)^y − cost, the cost not discounted; base at p, optimistic at
 * min(100, p+15), pessimistic at max(0, p−25). Each value is rounded once to cents from the double.
 */
export function settlement(claim: bigint, p: number, years: number, discount: number, cost: bigint): SettlementResult {
	const c = centsToNumber(claim), k = centsToNumber(cost);
	const ev = (prob: number): Scenario => {
		const exp = (c * prob) / 100;
		const pv = exp / Math.pow(1 + discount / 100, years);
		const cents = floatToCents(pv - k);
		if (cents === null) throw new RangeError('settlement value overflowed');
		return { probability: prob, cents };
	};
	return { pessimistic: ev(Math.max(0, p - 25)), base: ev(p), optimistic: ev(Math.min(100, p + 15)) };
}
