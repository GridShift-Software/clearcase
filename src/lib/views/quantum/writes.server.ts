import { registers, type DeleteResult, type Work } from '../../local-case/registers.server.ts';
import { paymentFields, paymentOf, PAYMENTS_STORE, type Payment } from './payments.ts';

export type { DeleteResult, Work };
export interface Entry { date: string; amount: string; method: string; note: string }

const store = (w: Work, caseId: string) => registers(w).open(caseId, PAYMENTS_STORE);

export const listPayments = (w: Work, caseId: string): (Payment & { hash: string })[] =>
	store(w, caseId).rows().map((r) => ({ ...paymentOf(r.rowId, r.fields), hash: r.version }));

export const addPayment = async (w: Work, caseId: string, e: Entry, cents: bigint): Promise<string> =>
	(await store(w, caseId).add(paymentFields(e, cents))).rowId;

export const deletePayment = (w: Work, caseId: string, rowId: string, hash: string): Promise<DeleteResult> => store(w, caseId).remove(rowId, hash);
