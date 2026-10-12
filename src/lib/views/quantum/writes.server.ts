// Payment writes of Payments & Net Claim (GRS-16, CC-06 r2). Every write (Add and Delete) of one case's payment store
// runs in one in-process queue, so `seq` is computed just before its putRow with no other payment write of this
// process in between (two tabs adding while the store is busy store distinct seq values in submission order), and a
// Delete re-reads its row just before deleteRow: a row that is gone is reported, and a row whose stored fields differ
// from the ones the page showed (a restore or a later import changed it) is not deleted. The check compares a hash of
// the stored fields, never updatedAt, which never changes under CLEARCASE_FIXED_NOW. One server process serves a data
// directory; a write outside this module (a restore, another process) is not in the queue (see the CC-06 r2 report).
import { createHash } from 'node:crypto';
import type { RegisterRow, RegisterValue, UserWork } from '../../local-case/user-work.server.ts';
import { nextSeq, ordered, paymentFields, paymentOf, PAYMENTS_STORE, type Payment } from './payments.ts';

export type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow'>;
export interface Entry { date: string; amount: string; method: string; note: string }
/** A Delete's outcome: deleted, the row is gone (deleted elsewhere), or its stored fields changed since the page showed them. */
export type DeleteResult = 'deleted' | 'gone' | 'stale';

/** The hash of a row's stored fields (listRows returns them in stored key order); the Delete form carries it. */
export const fieldsHash = (fields: Record<string, RegisterValue>): string => createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32);

/** The case's payments in insertion order, each with the hash of its stored fields. */
export const listPayments = (w: Work, caseId: string): (Payment & { hash: string })[] =>
	ordered(w.listRows(caseId, PAYMENTS_STORE).map((r: RegisterRow) => ({ ...paymentOf(r.rowId, r.fields), hash: fieldsHash(r.fields) }))) as (Payment & { hash: string })[];

const queues = new WeakMap<object, Map<string, Promise<unknown>>>();
/** Run one write after every earlier write of the same case's payments on the same service; a failure does not block the queue. */
export function serial<T>(w: Work, caseId: string, fn: () => Promise<T>): Promise<T> {
	let m = queues.get(w);
	if (!m) queues.set(w, (m = new Map()));
	const key = JSON.stringify([caseId, PAYMENTS_STORE]);
	const run = (m.get(key) ?? Promise.resolve()).then(fn);
	const tail = run.then(() => undefined, () => undefined);
	m.set(key, tail);
	void tail.then(() => { if (m.get(key) === tail) m.delete(key); });
	return run;
}

/** Store one payment after the last, its seq computed inside the queue; the new row id. Throws as putRow does (busy: 503). */
export const addPayment = (w: Work, caseId: string, e: Entry, cents: bigint): Promise<string> =>
	serial(w, caseId, async () => w.putRow(caseId, PAYMENTS_STORE, null, paymentFields(e, cents, nextSeq(listPayments(w, caseId)))));

/** Delete one payment by its stable id when its stored fields still hash to `hash` (the one the page showed). */
export const deletePayment = (w: Work, caseId: string, rowId: string, hash: string): Promise<DeleteResult> =>
	serial(w, caseId, async () => {
		const cur = w.listRows(caseId, PAYMENTS_STORE).find((r) => r.rowId === rowId);
		if (!cur) return 'gone';
		if (fieldsHash(cur.fields) !== hash) return 'stale';
		return (await w.deleteRow(caseId, PAYMENTS_STORE, rowId)) ? 'deleted' : 'gone';
	});
