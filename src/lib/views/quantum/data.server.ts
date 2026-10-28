import { citedRefs } from '../../components/cite.ts';
import type { Say } from '../../local-case/answer.server.ts';
import { app } from '../../local-case/app.server.ts';
import { resolveRefs } from '../../local-case/documents.server.ts';
import { datasetOf, exportFileName, viewContentOf, viewText } from '../../local-case/results.server.ts';
import type { PureInput } from '../payloads/views.ts';
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

export const dataset = <T>(vid: string, key: string): T | null => datasetOf<T>(app().store, vid, key);

export const content = (vid: string) => viewContentOf(app().store, vid);

export const resolvableRefs = (vid: string, refs: Iterable<string>): Set<string> => resolveRefs(app().store, vid, refs);

export const payments = (caseId: string) => listPayments(app().userWork, caseId);

// The three views over the payments register without the payments (ticket 04): what the operator machine builds into the shards.

export function paymentsPure({ store, vid, vc }: PureInput) {
	const settlement = datasetOf<Settlement>(store, vid, 'lit-settlement');
	const recon = datasetOf<ReconRow[]>(store, vid, 'lit-recon') ?? [];
	const cited = new Set(recon.flatMap((m) => [...m.invoice, ...m.supporting, ...m.charging, ...m.pod, ...m.statement, ...m.amountdue]));
	const known = resolveRefs(store, vid, cited);
	return {
		subtitle: viewText(vc, 'payments_tab', 'subtitle'),
		claim: settlement?.claim ?? '',
		claimDate: settlement?.claimDate ?? '',
		recon,
		exportName: exportFileName(vc, 'payments_tab', 'payments.csv'),
		known: [...cited].filter((r) => known.has(r)),
	};
}

export function interestPure({ store, vid, vc }: PureInput) {
	const basis = datasetOf<InterestBasis>(store, vid, 'lit-interest-basis');
	const note = basis?.note || null;
	return {
		defaults: { rate: vc.number('interest_calc_tab', 'defaultRate'), from: basis ? basis.first_invoice_date || basis.award_date : '', to: basis?.headline_date ?? '' },
		headlineDue: basis?.headline_due ?? '',
		headlineDate: basis?.headline_date ?? '',
		note,
		known: note ? [...resolveRefs(store, vid, citedRefs([note]))] : [],
	};
}

export function settlementPure({ store, vid, vc }: PureInput) {
	const s = datasetOf<Settlement>(store, vid, 'lit-settlement');
	return {
		subtitle: viewText(vc, 'settlement_tab', 'subtitle'),
		narrative: viewText(vc, 'settlement_tab', 'narrative'),
		defaults: {
			probability: vc.number('settlement_tab', 'defaultProbability'), years: vc.number('settlement_tab', 'defaultYears'),
			discount: vc.number('settlement_tab', 'defaultDiscountRate'), cost: vc.number('settlement_tab', 'defaultEnforcementCost'),
		},
		/** the imported claim as text; the page's claim is this net of the payments */
		importedClaim: s?.claim ?? null,
		claimDate: s?.claimDate ?? '',
	};
}

const ADD_REFUSED = 'Not saved: the workspace store refused this entry, and would refuse it again unchanged. Your entry is kept.';
const DELETE_REFUSED = 'Not deleted: the workspace store refused the deletion.';
export const SAY = {
	add: { busy: 'Not saved: the workspace store is busy (another process holds it). Your entry is kept; try again.', refused: ADD_REFUSED, failed: ADD_REFUSED },
	delete: { busy: 'Not deleted: the workspace store is busy (another process holds it); try again.', refused: DELETE_REFUSED, failed: DELETE_REFUSED },
} satisfies Record<string, Say>;
