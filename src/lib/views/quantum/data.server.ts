// Server-side reads shared by the quantum views (GRS-16): the imported datasets they show, the refs that resolve
// through the document-row contract (imported register plus provider rows, v5's allRows()), and the payment register.
// Imported values are returned unchanged; nothing here corrects or recomputes them.
import type { Say } from '../../local-case/answer.server.ts';
import { app } from '../../local-case/app.server.ts';
import { documentRows } from '../../local-case/documents.server.ts';
import { datasetOf, viewContentOf } from '../../local-case/results.server.ts';
import { listPayments } from './writes.server.ts';

export interface Quantum {
	amountDueSeries: SeriesRow[]; statementSeries: SeriesRow[]; interestSeries: SeriesRow[];
	invoiceLedger: LedgerRow[]; chargingCount: number; invoiceCount: number; grossInvoiced: string;
	headline_date: string; headline_due: string; headline_ref: string; headline_url: string;
}
export interface SeriesRow { amount: string; date: string; filename: string; ref: string; url: string }
export interface LedgerRow { amount: string; bundle: string; date: string; no: string; ref: string; text_status: string; url: string }
export interface PrescriptionRow { no: string; ref: string; date: string; prescDate: string; risk: string; url: string }
export interface PrescSummary { awardDate: string; note: string; reliesOnInterruption: number; total: number }
export interface InterestBasis { award_date: string; first_invoice_date: string; headline_date: string; headline_due: string; note: string }
export interface ReconRow { month: string; invoice: string[]; statement: string[]; supporting: string[]; charging: string[]; amountdue: string[]; pod: string[] }
export interface Settlement { claim: string; claimDate: string }

/** A dataset of the version, or null when the package does not carry it. */
export const dataset = <T>(vid: string, key: string): T | null => datasetOf<T>(app().store, vid, key);

/** The version's view-content reader (GRS-38). */
export const content = (vid: string) => viewContentOf(app().store, vid);

/** The refs that resolve in this version: every document row, imported or provided (v5's allRows()). */
export const resolvableRefs = (vid: string): Set<string> => new Set(documentRows(app().store, vid).rows.map((r) => r.ref));

/** The case's recorded payments, in insertion order, each with the hash of its stored fields (the Delete check). */
export const payments = (caseId: string) => listPayments(app().userWork, caseId);

/**
 * What the payment forms say when a write fails (answer.server.ts): the typed entry is kept, and only a busy store says
 * "try again" (`retry`): another refusal would refuse a retry of the same entry too (CC-06 r2, D18).
 */
const ADD_REFUSED = 'Not saved: the workspace store refused this entry, and would refuse it again unchanged. Your entry is kept.';
const DELETE_REFUSED = 'Not deleted: the workspace store refused the deletion.';
export const SAY = {
	add: { busy: 'Not saved: the workspace store is busy (another process holds it). Your entry is kept; try again.', refused: ADD_REFUSED, failed: ADD_REFUSED },
	delete: { busy: 'Not deleted: the workspace store is busy (another process holds it); try again.', refused: DELETE_REFUSED, failed: DELETE_REFUSED },
} satisfies Record<string, Say>;
