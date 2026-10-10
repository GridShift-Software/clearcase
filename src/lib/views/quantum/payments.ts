// Payments & Net Claim (GRS-16): the payment register's rows, their order and the net claim. Browser-safe and pure.
// One parse feeds both the table and the totals (S-payments_tab-1): a row's `amountCents` is what the table shows and
// what the net claim subtracts. A row whose amount never parsed (a later import of v5's browser store could bring
// one) is shown as typed and flagged as not counted, never coerced (S-payments_tab-2).
import { toCSV, userCell } from '../../components/csv.ts';
import { centsToUnits, unitsToCents } from '../../calculations/money.ts';

/** The register_row store of recorded payments (one per case). */
export const PAYMENTS_STORE = 'payments';

export interface Payment { rowId: string; seq: number; date: string; amount: string; amountCents: bigint | null; method: string; note: string }

type Fields = Record<string, string | number | boolean | null>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A stored row as a payment; `amountCents` only when it is a safe integer the grammar produced. */
export function paymentOf(rowId: string, f: Fields): Payment {
	const c = f.amountCents;
	return { rowId, seq: typeof f.seq === 'number' && Number.isSafeInteger(f.seq) ? f.seq : 0, date: str(f.date), amount: str(f.amount), amountCents: typeof c === 'number' && Number.isSafeInteger(c) ? BigInt(c) : null, method: str(f.method), note: str(f.note) };
}

/** Insertion order: by `seq`, ties (never written by the app) by row id. listRows order is not insertion order. */
export const ordered = (rows: readonly Payment[]) => [...rows].sort((a, b) => a.seq - b.seq || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));

/** The next row's `seq`: one more than the largest stored. */
export const nextSeq = (rows: readonly Payment[]) => rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;

/** The fields stored for a new payment: the text as typed, the parsed cents, and its position. */
export const paymentFields = (p: { date: string; amount: string; method: string; note: string }, cents: bigint, seq: number): Fields =>
	({ date: p.date, amount: p.amount, amountCents: Number(cents), method: p.method, note: p.note, seq });

export interface Totals { gross: bigint; paid: bigint; net: bigint; receipts: number; uncounted: number }

/** Gross (the imported claim, ten-thousandths), payments and net claim in cents; each rounded once. */
export function totals(claimUnits: bigint, rows: readonly Payment[]): Totals {
	const paid = rows.reduce((a, r) => a + (r.amountCents ?? 0n), 0n);
	return { gross: unitsToCents(claimUnits), paid, net: unitsToCents(claimUnits - centsToUnits(paid)), receipts: rows.length, uncounted: rows.filter((r) => r.amountCents === null).length };
}

/** v5's payments export: date, amount, method, note as typed, in insertion order; user-typed cells are neutralised. */
export const paymentsCsv = (rows: readonly Payment[]) =>
	toCSV([['date', 'amount', 'method', 'note'], ...ordered(rows).map((r) => [r.date, r.amount, r.method, r.note].map(userCell))]);
