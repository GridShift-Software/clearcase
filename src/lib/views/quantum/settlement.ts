import { fmtR } from '../../components/format.ts';
import { settlement } from '../../calculations/interest.ts';
import { centsText, divRound, importedUnits, parseAmount, parseBounded, TOO_LARGE, withinCap, type Parsed } from '../../calculations/money.ts';
import type { settlementPure } from './data.server.ts';
import { totals, type PaymentsWork } from './payments.ts';

export const MAX_PROBABILITY = 100;
export const MAX_YEARS = 100;
export const MAX_DISCOUNT = 100;

export function parseClaim(text: string): Parsed<bigint> {
	const t = text.trim();
	const neg = /^-(?!-)/.test(t);
	const a = parseAmount(neg ? t.slice(1) : t);
	return a.ok ? { ok: true, value: neg ? -a.value : a.value } : a;
}

export interface SettleInputs { claim: string; p: string; y: string; d: string; c: string }
export type SettleField = keyof SettleInputs;
export const SETTLE_FIELDS: readonly SettleField[] = ['claim', 'p', 'y', 'd', 'c'];

export interface SettleDefaults { probability: number | null; years: number | null; discount: number | null; cost: number | null }

export const claimPrefill = (netCents: bigint) => String(divRound(netCents, 100n));

const num = (n: number | null) => (n === null ? '' : String(n));
export const defaultInputs = (claim: string, d: SettleDefaults): SettleInputs => ({ claim, p: num(d.probability), y: num(d.years), d: num(d.discount), c: num(d.cost) });

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

/** The Settlement shard (ticket 04): the view without the payments it nets off the claim. */
export type SettlementShard = ReturnType<typeof settlementPure>;

export function settlementMerge(shard: SettlementShard, work: PaymentsWork) {
	const pays = work.payments;
	const t = totals(importedUnits(shard.importedClaim) ?? 0n, pays);
	return {
		subtitle: shard.subtitle,
		narrative: shard.narrative,
		defaults: shard.defaults,
		claim: claimPrefill(t.net),
		payments: { count: pays.length, counted: pays.length - t.uncounted, gross: String(t.gross), paid: String(t.paid), excess: t.paid > t.gross ? String(t.paid - t.gross) : null, claimDate: shard.claimDate },
	};
}
