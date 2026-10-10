// Settlement / BATNA (GRS-16): v5's risk-adjusted model with its inputs in the URL query (BA-03). The defaults are
// the package's (view-content, S-settlement_tab-1); the claim prefill is the claim net of recorded payments
// (S-settlement_tab-2), in whole rand as v5 prefilled it (toFixed(0), S-settlement_tab-3 kept for the prefill). Every
// field is parsed with one grammar and refused visibly when it does not parse. CC-06 r2: the claim accepts one leading
// minus, as v5's model does (D10: a claim net of payments above it is negative, and v5 models it); the probability is
// 0 to 100 (D11), the years and the discount rate have bounds (D6), and a figure too large to compute or show is an
// error, never a crash (D5). Pure.
import { fmtR } from '../../components/format.ts';
import { settlement } from '../../calculations/interest.ts';
import { centsText, divRound, parseAmount, parseBounded, TOO_LARGE, withinCap, type Parsed } from '../../calculations/money.ts';

/** The accepted ranges (CC-06 r2, D6 and D11). */
export const MAX_PROBABILITY = 100;
export const MAX_YEARS = 100;
export const MAX_DISCOUNT = 100;

/** The claim: a typed amount with one optional leading minus (v5 models a negative claim; costs stay non-negative). */
export function parseClaim(text: string): Parsed<bigint> {
	const t = text.trim();
	const neg = /^-(?!-)/.test(t);
	const a = parseAmount(neg ? t.slice(1) : t);
	return a.ok ? { ok: true, value: neg ? -a.value : a.value } : a;
}

export interface SettleInputs { claim: string; p: string; y: string; d: string; c: string }
export type SettleField = keyof SettleInputs;
export const SETTLE_FIELDS: readonly SettleField[] = ['claim', 'p', 'y', 'd', 'c'];

/** The package defaults (null when view-content lacks one: the field stays empty, never a literal). */
export interface SettleDefaults { probability: number | null; years: number | null; discount: number | null; cost: number | null }

/** v5's claim prefill: whole rand, rounded half away from zero (toFixed(0)), here of the net claim in cents. */
export const claimPrefill = (netCents: bigint) => String(divRound(netCents, 100n));

const num = (n: number | null) => (n === null ? '' : String(n));
export const defaultInputs = (claim: string, d: SettleDefaults): SettleInputs => ({ claim, p: num(d.probability), y: num(d.years), d: num(d.discount), c: num(d.cost) });

/** The query's inputs over the defaults (a field the query lacks keeps its default). */
export function settleInputs(q: URLSearchParams, def: SettleInputs): SettleInputs {
	return Object.fromEntries(SETTLE_FIELDS.map((k) => [k, q.get(k) ?? def[k]])) as unknown as SettleInputs;
}
export const submitted = (q: URLSearchParams) => SETTLE_FIELDS.some((k) => q.has(k));

export interface Kpi { label: string; value: string; sub: string }
export interface SettleOutcome { errors: Partial<Record<SettleField | 'result', string>>; kpis: Kpi[] | null; floor: string | null }

const R = (c: bigint) => fmtR(centsText(c));

export function settleOutcome(i: SettleInputs): SettleOutcome {
	const errors: SettleOutcome['errors'] = {};
	const claim = parseClaim(i.claim);
	if (!claim.ok) errors.claim = `Claim value: ${claim.error}`;
	const cost = parseAmount(i.c);
	if (!cost.ok) errors.c = `Enforcement cost: ${cost.error}`;
	const p = parseBounded(i.p, 'a probability', MAX_PROBABILITY, `A probability is 0 to ${MAX_PROBABILITY}`);
	if (!p.ok) errors.p = p.error;
	const y = parseBounded(i.y, 'a number of years', MAX_YEARS, `Years to recover are 0 to ${MAX_YEARS}`);
	if (!y.ok) errors.y = y.error;
	const d = parseBounded(i.d, 'a discount rate', MAX_DISCOUNT, `A discount rate is 0 to ${MAX_DISCOUNT} % per annum`);
	if (!d.ok) errors.d = d.error;
	if (!claim.ok || !cost.ok || !p.ok || !y.ok || !d.ok) return { errors, kpis: null, floor: null };
	let s: ReturnType<typeof settlement>;
	try { s = settlement(claim.value, p.value.value, y.value.value, d.value.value, cost.value); } catch { return { errors: { result: TOO_LARGE }, kpis: null, floor: null }; }
	if (![s.pessimistic.cents, s.base.cents, s.optimistic.cents, claim.value, cost.value].every(withinCap)) return { errors: { result: TOO_LARGE }, kpis: null, floor: null };
	const pv = p.value.value;
	return {
		errors,
		kpis: [
			{ label: 'Pessimistic (p-25)', value: R(s.pessimistic.cents), sub: '' },
			{ label: `Base (p=${pv}%)`, value: R(s.base.cents), sub: '' },
			{ label: 'Optimistic (p+15)', value: R(s.optimistic.cents), sub: '' },
		],
		floor: `a rational settlement sits around the base risk-adjusted present value of ${R(s.base.cents)} (claim ${R(claim.value)} discounted for a ${pv}% recovery probability over ${y.value.value} year(s) at ${d.value.value}%, net of ${R(cost.value)} costs). Below this, litigation is preferable; a premium above it reflects certainty and time saved.`,
	};
}
