// Payment writes of Payments & Net Claim (GRS-16, CC-06 r2), on the register store (local-case/registers.server.ts,
// GRS-52): one queue per case's payments, `seq` computed just before each Add's write, and a Delete re-checked just
// before it against the version (a hash of the stored fields) the page showed: a payment that is gone is said, one
// whose stored fields changed since (a restore, a later import) is not deleted.
import { registers, type DeleteResult, type Work } from '../../local-case/registers.server.ts';
import { paymentFields, paymentOf, PAYMENTS_STORE, type Payment } from './payments.ts';

export type { DeleteResult, Work };
export interface Entry { date: string; amount: string; method: string; note: string }

const store = (w: Work, caseId: string) => registers(w).open(caseId, PAYMENTS_STORE);

/** The case's payments in insertion order, each with its version (`hash`), which the Delete form carries. */
export const listPayments = (w: Work, caseId: string): (Payment & { hash: string })[] =>
	store(w, caseId).rows().map((r) => ({ ...paymentOf(r.rowId, r.fields), hash: r.version }));

/** Store one payment after the last; the new row id. Throws as putRow does (busy: 503). */
export const addPayment = async (w: Work, caseId: string, e: Entry, cents: bigint): Promise<string> =>
	(await store(w, caseId).add(paymentFields(e, cents))).rowId;

/** Delete one payment by its stable id when it is still at `hash` (the version the page showed). */
export const deletePayment = (w: Work, caseId: string, rowId: string, hash: string): Promise<DeleteResult> => store(w, caseId).remove(rowId, hash);
