import { fmtR } from '../../components/format.ts';
import { dateProblem, daysBetween, isIsoDate } from '../../calculations/dates.ts';
import { computeInterest, METHODS, type Method } from '../../calculations/interest.ts';
import { centsText, centsToUnits, parseAmount, parseBounded, TOO_LARGE, unitsToCents, withinCap } from '../../calculations/money.ts';

export const MAX_RATE = 100;

export interface InterestInputs { p: string; r: string; m: string; from: string; to: string }
export type InterestField = keyof InterestInputs;
export const INTEREST_FIELDS: readonly InterestField[] = ['p', 'r', 'm', 'from', 'to'];

export interface InterestDefaults { rate: number | null; from: string; to: string }
export const defaultInputs = (d: InterestDefaults): InterestInputs => ({ p: '', r: d.rate === null ? '' : String(d.rate), m: 'Simple', from: d.from, to: d.to });

export function queryInputs(q: URLSearchParams, d: InterestDefaults): InterestInputs | null {
	if (!INTEREST_FIELDS.some((k) => q.has(k))) return null;
	const def = defaultInputs(d);
	return Object.fromEntries(INTEREST_FIELDS.map((k) => [k, q.get(k) ?? def[k]])) as unknown as InterestInputs;
}

export interface Kpi { label: string; value: string; sub: string }
export interface InterestOutcome { errors: Partial<Record<InterestField | 'result', string>>; kpis: Kpi[] | null }

const R = (c: bigint) => fmtR(centsText(c));
const ENTER_CAPITAL = 'enter a capital figure';

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
			{ label: 'vs extracted Amount Due', value: R(unitsToCents(head)), sub: capital ? `${diff >= 0n ? '+' : ''}${R(diff)} vs your calc` : ENTER_CAPITAL },
		],
	};
}

/** The imported amount due, its as-at date and the dates of the case's recorded payments: what the comparison stands on. */
export interface Due { units: bigint | null; date: string; paymentDates: readonly string[] }
/** The comparison's verdict, and each figure's basis and payment treatment, in words. */
export interface Comparison { verdict: string; total: string; due: string }
export interface ShownOutcome extends InterestOutcome { comparison: Comparison | null; basisNote: string | null }

/**
 * Why the computed total and the imported amount due are not on one basis (GRS-173, S-interest_calc_tab-5,
 * S-payments_tab-3); empty when they are. The total is as at To and deducts no payment, so the two compare only when the
 * amount due is as at To and no recorded payment is dated on or before To or undated. Netting a payment would need a
 * rule on whether it pays interest or capital first, a legal choice ClearCase does not make (an arithmetic aid only).
 */
export function unlikeBasis(to: string, due: Due): string[] {
	const why: string[] = [];
	if (due.units === null) why.push('this package gives no amount due');
	else if (!isIsoDate(due.date)) why.push('the amount due has no as-at date');
	else if (due.date !== to) why.push(`your total is as at ${to} and the amount due as at ${due.date}`);
	const n = due.paymentDates.filter((d) => !isIsoDate(d) || d <= to).length;
	if (n) why.push(`${n} recorded payment${n === 1 ? ' is' : 's are'} dated on or before ${to} or undated, and your total deducts none: netting ${n === 1 ? 'it' : 'them'} needs a rule on whether a payment pays interest or capital first, which ClearCase does not apply`);
	return why;
}

/**
 * The outcome the view shows: v5's comparison line only where the two figures share a date and no payment is in reach;
 * otherwise the amount due alone, not compared, and why. Even then the line is arithmetic, not a reconciliation:
 * the amount due is the statement's own balance, and ClearCase does not know its capital, rates or dates. With no
 * capital typed there is nothing to compare, so no verdict is shown.
 */
export function shownOutcome(i: InterestInputs, due: Due): ShownOutcome {
	const o = interestOutcome(i, due.units);
	if (!o.kpis) return { ...o, comparison: null, basisNote: null };
	const why = unlikeBasis(i.to, due);
	const asAt = isIsoDate(due.date) ? `as at ${due.date}` : 'with no as-at date';
	const [capital, interest, total, line] = o.kpis as [Kpi, Kpi, Kpi, Kpi];
	if (line.sub === ENTER_CAPITAL) {
		const alone = due.units === null ? { value: '—', sub: `not in this package · ${ENTER_CAPITAL}` } : { value: line.value, sub: `${asAt} · ${ENTER_CAPITAL}` };
		return { ...o, kpis: [capital, interest, total, { label: line.label, ...alone }], comparison: null,
			basisNote: why.length ? `Once you enter a capital figure, these figures cannot be compared: ${why.join('; ')}.` : null };
	}
	const comparison = {
		verdict: why.length ? `Not compared, so no difference is shown: ${why.join('; ')}.` : `Same date, no payment recorded on or before it: both figures are as at ${i.to}. The difference is arithmetic, not a reconciliation: ClearCase does not know the statement's capital, rates or dates.`,
		total: `Your total: the capital plus ${i.m.toLowerCase()} interest from ${i.from} to ${i.to}, on that one figure for the whole period. No payment is deducted.`,
		due: due.units === null ? 'Extracted amount due: none in this package.' : `Extracted amount due: ${asAt}, as the source statement gives it; ClearCase does not check what it includes. No recorded payment is deducted from it here; Payments & Net Claim deducts them for the net claim.`,
	};
	if (!why.length) return { ...o, comparison, basisNote: null };
	const alone = due.units === null ? { value: '—', sub: 'not in this package' } : { value: line.value, sub: `${asAt}: not comparable with your total` };
	return { ...o, kpis: [capital, interest, total, { label: line.label, ...alone }], comparison, basisNote: null };
}
