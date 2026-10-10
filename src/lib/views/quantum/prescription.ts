// Prescription (GRS-16): v5's filters, pages and export, with the filter in the URL so the controls always show it
// (S-prescription_tab-1) and the export following the shown rows (S-prescription_tab-3, BA-17); and the arithmetic
// checks of BA-01: how many imported prescription dates equal invoice date + 3 years, and how many fall on or before
// an explicit as-of date. The imported dates and risk labels are shown unchanged; the legal rule (leap day, < or <=,
// interruption) is not decided here. Browser-safe and pure.
import { toCSV } from '../../components/csv.ts';
import { addYears, isIsoDate } from '../../calculations/dates.ts';

export interface PrescRow { no: string; ref: string; date: string; prescDate: string; risk: string; url: string }
export interface PrescSummary { awardDate: string; note: string; reliesOnInterruption: number; total: number }

export const PAGE_SIZE = 80;
export const RELIES = 'Relies on interruption';
/** v5's risk options; any other risk value the package carries is offered after them, so every row can be selected. */
export const V5_RISKS = [RELIES, 'Not yet due to prescribe'];
export const riskOptions = (rows: readonly PrescRow[]) => [...V5_RISKS, ...[...new Set(rows.map((r) => r.risk))].filter((r) => r && !V5_RISKS.includes(r)).sort()];

export interface PrescQuery { q: string; risk: string; page: number }
export function queryFrom(p: URLSearchParams): PrescQuery {
	const page = Number(p.get('page'));
	return { q: p.get('q') ?? '', risk: p.get('risk') ?? '', page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}
export function paramsFrom(q: PrescQuery): URLSearchParams {
	const p = new URLSearchParams();
	if (q.q) p.set('q', q.q);
	if (q.risk) p.set('risk', q.risk);
	if (q.page > 1) p.set('page', String(q.page));
	return p;
}

/** v5 prescFiltered: data order; the text filter is a case-insensitive substring of 'no ref' (not trimmed); risk exact. */
export function filterRows(rows: readonly PrescRow[], q: Pick<PrescQuery, 'q' | 'risk'>): PrescRow[] {
	const needle = q.q.toLowerCase();
	return rows.filter((r) => (!needle || `${r.no} ${r.ref}`.toLowerCase().includes(needle)) && (!q.risk || r.risk === q.risk));
}

export interface Page<T> { slice: T[]; page: number; pages: number; total: number; from: number; to: number }
/** v5 paginate: the page is clamped into range. */
export function paginate<T>(arr: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
	const total = arr.length;
	const pages = Math.max(1, Math.ceil(total / size));
	const p = Math.min(Math.max(1, page), pages);
	return { slice: arr.slice((p - 1) * size, (p - 1) * size + size), page: p, pages, total, from: total ? (p - 1) * size + 1 : 0, to: Math.min(p * size, total) };
}

/** The export: v5's columns (url omitted, as v5), the rows as shown, filtered and in order; imported values unchanged. */
export const PRESC_COLUMNS = ['ref', 'no', 'date', 'prescDate', 'risk'] as const;
export const prescriptionCsv = (rows: readonly PrescRow[]) => toCSV([[...PRESC_COLUMNS], ...rows.map((r) => PRESC_COLUMNS.map((k) => r[k]))]);

export type AsOf = 'passed' | 'not-reached' | 'no-date';
/** Whether a row's imported prescription date is on or before the as-of date (arithmetic only). */
export const asOfStatus = (r: PrescRow, asOf: string): AsOf => (!isIsoDate(r.prescDate) ? 'no-date' : r.prescDate <= asOf ? 'passed' : 'not-reached');
export const AS_OF_TEXT: Record<AsOf, string> = { passed: '3-yr date passed', 'not-reached': '3-yr date not reached', 'no-date': 'no valid date' };

export interface Arithmetic { rows: number; plusThree: number; leapInvoices: number; leapMovedTo28: number; passed: number; asOf: string }
/**
 * BA-01's two figures: rows whose imported prescription date is invoice date + 3 calendar years (29 February moved to
 * 28 February when the target year is not leap), and rows whose prescription date is on or before `asOf`.
 */
export function arithmetic(rows: readonly PrescRow[], asOf: string): Arithmetic {
	const leap = rows.filter((r) => isIsoDate(r.date) && r.date.endsWith('-02-29'));
	return {
		rows: rows.length,
		plusThree: rows.filter((r) => addYears(r.date, 3) === r.prescDate).length,
		leapInvoices: leap.length,
		leapMovedTo28: leap.filter((r) => r.prescDate.endsWith('-02-28') && addYears(r.date, 3) === r.prescDate).length,
		passed: rows.filter((r) => asOfStatus(r, asOf) === 'passed').length,
		asOf,
	};
}

export interface SummaryCheck { totalMatches: boolean; reliesMatches: boolean; reliesCount: number }
/** The imported summary KPIs against the counts derived from the rows (a mismatch is flagged, never corrected). */
export function summaryCheck(s: PrescSummary, rows: readonly PrescRow[]): SummaryCheck {
	const reliesCount = rows.filter((r) => r.risk === RELIES).length;
	return { totalMatches: s.total === rows.length, reliesMatches: s.reliesOnInterruption === reliesCount, reliesCount };
}
