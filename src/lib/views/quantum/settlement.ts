// Settlement / BATNA (GRS-16): v5's risk-adjusted model with its inputs in the URL query (BA-03). The defaults are
// the package's (view-content, S-settlement_tab-1); the claim prefill is the claim net of recorded payments
// (S-settlement_tab-2), in whole rand as v5 prefilled it (toFixed(0), S-settlement_tab-3 kept for the prefill). Every
// field is parsed with one grammar and refused visibly when it does not parse. Pure.
import { fmtR } from '../../components/format.ts';
import { settlement } from '../../calculations/interest.ts';
import { centsText, divRound, parseAmount, parseDecimal } from '../../calculations/money.ts';

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
export interface SettleOutcome { errors: Partial<Record<SettleField, string>>; kpis: Kpi[] | null; floor: string | null }

const R = (c: bigint) => fmtR(centsText(c));

export function settleOutcome(i: SettleInputs): SettleOutcome {
	const errors: SettleOutcome['errors'] = {};
	const claim = parseAmount(i.claim);
	if (!claim.ok) errors.claim = `Claim value: ${claim.error}`;
	const cost = parseAmount(i.c);
	if (!cost.ok) errors.c = `Enforcement cost: ${cost.error}`;
	const p = parseDecimal(i.p, 'a probability');
	if (!p.ok) errors.p = p.error;
	const y = parseDecimal(i.y, 'a number of years');
	if (!y.ok) errors.y = y.error;
	const d = parseDecimal(i.d, 'a discount rate');
	if (!d.ok) errors.d = d.error;
	if (!claim.ok || !cost.ok || !p.ok || !y.ok || !d.ok) return { errors, kpis: null, floor: null };
	const s = settlement(claim.value, p.value.value, y.value.value, d.value.value, cost.value);
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
