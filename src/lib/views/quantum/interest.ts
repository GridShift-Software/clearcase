// Interest Recalculator (GRS-16): the calculator's inputs live in the URL query (BA-03), so a reload or a shared link
// gives the same result; without a query the fields show the defaults (the rate from the package's view-content,
// the dates from the imported interest basis). Validation is visible and keeps the typed text: an amount outside the
// grammar (S-interest_calc_tab-1), a missing rate, an invalid or reversed period (S-interest_calc_tab-3). CC-06 r2: a
// rate above MAX_RATE, a year outside 1000 to 9999 (D7) and a result too large to compute or show (D5, D6) are refused
// visibly too, the inputs kept; nothing here throws. Pure.
import { fmtR } from '../../components/format.ts';
import { dateProblem, daysBetween } from '../../calculations/dates.ts';
import { computeInterest, METHODS, type Method } from '../../calculations/interest.ts';
import { centsText, centsToUnits, parseAmount, parseBounded, TOO_LARGE, unitsToCents, withinCap } from '../../calculations/money.ts';

/** The rate's accepted range, % per annum (CC-06 r2, D6). */
export const MAX_RATE = 100;

export interface InterestInputs { p: string; r: string; m: string; from: string; to: string }
export type InterestField = keyof InterestInputs;
export const INTEREST_FIELDS: readonly InterestField[] = ['p', 'r', 'm', 'from', 'to'];

/** The defaults: the rate as view-content gives it ('' when absent: no literal stands in), the basis dates. */
export interface InterestDefaults { rate: number | null; from: string; to: string }
export const defaultInputs = (d: InterestDefaults): InterestInputs => ({ p: '', r: d.rate === null ? '' : String(d.rate), m: 'Simple', from: d.from, to: d.to });

/** The inputs a query holds (a submitted calculation), or null when it holds none (show the defaults). */
export function queryInputs(q: URLSearchParams, d: InterestDefaults): InterestInputs | null {
	if (!INTEREST_FIELDS.some((k) => q.has(k))) return null;
	const def = defaultInputs(d);
	return Object.fromEntries(INTEREST_FIELDS.map((k) => [k, q.get(k) ?? def[k]])) as unknown as InterestInputs;
}

export interface Kpi { label: string; value: string; sub: string }
/** Field errors, and `result` when the inputs are valid but the result is too large to compute or show. */
export interface InterestOutcome { errors: Partial<Record<InterestField | 'result', string>>; kpis: Kpi[] | null }

const R = (c: bigint) => fmtR(centsText(c));

/**
 * Compute what v5's Compute shows: Capital, Interest (<years> yrs), Total, and the comparison with the imported amount
 * due (S-interest_calc_tab-5 kept: the total on one capital figure against the headline). An empty capital is zero,
 * as in v5 ("enter a capital figure"); any other unparsable field is an error and nothing is computed.
 */
export function interestOutcome(i: InterestInputs, headlineDueUnits: bigint | null): InterestOutcome {
	const errors: InterestOutcome['errors'] = {};
	let capital = 0n;
	if (i.p.trim() !== '') { const a = parseAmount(i.p); if (a.ok) capital = a.value; else errors.p = a.error; }
	const rate = parseBounded(i.r, 'a rate', MAX_RATE, `A rate is 0 to ${MAX_RATE} % per annum`);
	if (!rate.ok) errors.r = rate.error;
	const method = METHODS.includes(i.m as Method) ? (i.m as Method) : null;
	if (!method) errors.m = i.m === '' ? 'Choose Simple or Compound (monthly).' : `Method '${i.m}' is not one this calculator offers: choose Simple or Compound (monthly).`;
	const fromProblem = dateProblem('From (mora)', i.from), toProblem = dateProblem('To', i.to);
	if (fromProblem) errors.from = fromProblem;
	if (toProblem) errors.to = toProblem;
	const days = errors.from || errors.to ? null : daysBetween(i.from, i.to);
	if (days !== null && days < 0) errors.to = 'The To date is before the From (mora) date: a reversed period is not computed.';
	if (Object.keys(errors).length || !rate.ok || !method || days === null) return { errors, kpis: null };
	let r: ReturnType<typeof computeInterest>;
	try { r = computeInterest(capital, rate.value, method, days); } catch { return { errors: { result: TOO_LARGE }, kpis: null }; }
	const head = headlineDueUnits ?? 0n;
	const diff = unitsToCents(centsToUnits(r.total) - head);
	if (![r.capital, r.interest, r.total, diff, unitsToCents(head)].every(withinCap)) return { errors: { result: TOO_LARGE }, kpis: null };
	return {
		errors,
		kpis: [
			{ label: 'Capital', value: R(r.capital), sub: '' },
			{ label: `Interest (${r.yearsLabel} yrs)`, value: R(r.interest), sub: '' },
			{ label: 'Total', value: R(r.total), sub: '' },
			{ label: 'vs extracted Amount Due', value: R(unitsToCents(head)), sub: capital ? `${diff >= 0n ? '+' : ''}${R(diff)} vs your calc` : 'enter a capital figure' },
		],
	};
}
