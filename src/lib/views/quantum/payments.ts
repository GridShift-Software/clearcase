import { toCSV, userCell } from '../../components/csv.ts';
import { dateProblem } from '../../calculations/dates.ts';
import { centsToUnits, parseAmount, unitsToCents } from '../../calculations/money.ts';
import type { paymentsPure } from './data.server.ts';

export const PAYMENTS_STORE = 'payments';

export interface Payment { rowId: string; seq: number; date: string; amount: string; amountCents: bigint | null; method: string; note: string }

type Fields = Record<string, string | number | boolean | null>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function paymentOf(rowId: string, f: Fields): Payment {
	const c = f.amountCents;
	return { rowId, seq: typeof f.seq === 'number' && Number.isSafeInteger(f.seq) ? f.seq : 0, date: str(f.date), amount: str(f.amount), amountCents: typeof c === 'number' && Number.isSafeInteger(c) ? BigInt(c) : null, method: str(f.method), note: str(f.note) };
}

export const paymentFields = (p: { date: string; amount: string; method: string; note: string }, cents: bigint): Fields =>
	({ date: p.date, amount: p.amount, amountCents: Number(cents), method: p.method, note: p.note });

export const MAX_LENGTH = { date: 10, amount: 40, method: 200, note: 2000 } as const;
export const LABEL = { date: 'Date', amount: 'Amount', method: 'Method / reference', note: 'Note' } as const;
export type EntryField = keyof typeof MAX_LENGTH;

export function checkEntry(e: Record<EntryField, string>): { ok: true; cents: bigint } | { ok: false; field: EntryField; error: string } {
	for (const k of ['date', 'amount', 'method', 'note'] as const) {
		const n = e[k].length;
		if (n > MAX_LENGTH[k]) return { ok: false, field: k, error: `${LABEL[k]}: at most ${MAX_LENGTH[k].toLocaleString('en').replace(/,/g, ' ')} characters (this one has ${n.toLocaleString('en').replace(/,/g, ' ')}). Your text is kept; shorten it, then add it again.` };
	}
	if (e.date !== '') { const why = dateProblem('Date', e.date); if (why) return { ok: false, field: 'date', error: why }; }
	const a = parseAmount(e.amount);
	return a.ok ? { ok: true, cents: a.value } : { ok: false, field: 'amount', error: a.error };
}

export interface Totals { gross: bigint; paid: bigint; net: bigint; receipts: number; uncounted: number }

export function totals(claimUnits: bigint, rows: readonly Payment[]): Totals {
	const paid = rows.reduce((a, r) => a + (r.amountCents ?? 0n), 0n);
	return { gross: unitsToCents(claimUnits), paid, net: unitsToCents(claimUnits - centsToUnits(paid)), receipts: rows.length, uncounted: rows.filter((r) => r.amountCents === null).length };
}

export const paymentsCsv = (rows: readonly Payment[]) =>
	toCSV([['date', 'amount', 'method', 'note'], ...rows.map((r) => [r.date, r.amount, r.method, r.note].map(userCell))]);

/** The payments register as the views read it: each payment with its row version. */
export interface PaymentsWork { payments: readonly (Payment & { hash: string })[] }

/** The Payments & Net Claim shard (ticket 04): the view without the payments. */
export type PaymentsShard = ReturnType<typeof paymentsPure>;

export const paymentsMerge = (shard: PaymentsShard, work: PaymentsWork) => ({
	...shard,
	payments: work.payments.map((p) => ({ ...p, amountCents: p.amountCents === null ? null : String(p.amountCents) })),
});
