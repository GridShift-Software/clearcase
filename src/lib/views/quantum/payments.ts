// Payments & Net Claim (GRS-16): the payment register's rows, their order and the net claim. Browser-safe and pure.
// One parse feeds both the table and the totals (S-payments_tab-1): a row's `amountCents` is what the table shows and
// what the net claim subtracts. A row whose amount never parsed (a later import of v5's browser store could bring
// one) is shown as typed and flagged as not counted, never coerced (S-payments_tab-2).
import { toCSV, userCell } from '../../components/csv.ts';
import { dateProblem } from '../../calculations/dates.ts';
import { centsToUnits, parseAmount, unitsToCents } from '../../calculations/money.ts';

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

/**
 * The longest text each field takes, in characters (CC-06 r2, D18). JSON writes a character in at most 6 bytes, so the
 * four fields together stay far below the store's 64 KiB cap and a refused entry is refused for a reason a correction
 * can fix, never by the store.
 */
export const MAX_LENGTH = { date: 10, amount: 40, method: 200, note: 2000 } as const;
export const LABEL = { date: 'Date', amount: 'Amount', method: 'Method / reference', note: 'Note' } as const;
export type EntryField = keyof typeof MAX_LENGTH;

/**
 * Why an entry cannot be stored, with the field to mark, or its amount in cents. Shared by the action (with and
 * without JavaScript) and the page's own pre-check: each field's length, the date (empty, or a calendar date with a
 * year from 1000 to 9999: D8) and the amount grammar (S-payments_tab-2). The typed text is never changed.
 */
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

/** Gross (the imported claim, ten-thousandths), payments and net claim in cents; each rounded once. */
export function totals(claimUnits: bigint, rows: readonly Payment[]): Totals {
	const paid = rows.reduce((a, r) => a + (r.amountCents ?? 0n), 0n);
	return { gross: unitsToCents(claimUnits), paid, net: unitsToCents(claimUnits - centsToUnits(paid)), receipts: rows.length, uncounted: rows.filter((r) => r.amountCents === null).length };
}

/** v5's payments export: date, amount, method, note as typed, in insertion order; user-typed cells are neutralised. */
export const paymentsCsv = (rows: readonly Payment[]) =>
	toCSV([['date', 'amount', 'method', 'note'], ...ordered(rows).map((r) => [r.date, r.amount, r.method, r.note].map(userCell))]);
