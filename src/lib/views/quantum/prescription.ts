import { toCSV } from '../../components/csv.ts';
import { addYears, isIsoDate } from '../../calculations/dates.ts';

export interface PrescRow { no: string; ref: string; date: string; prescDate: string; risk: string; url: string }
export interface PrescSummary { awardDate: string; note: string; reliesOnInterruption: number; total: number }

export const PAGE_SIZE = 80;
export const RELIES = 'Relies on interruption';
export const V5_RISKS = [RELIES, 'Not yet due to prescribe'];
export const riskOptions = (rows: readonly PrescRow[]) => [...V5_RISKS, ...[...new Set(rows.map((r) => r.risk))].filter((r) => r && !V5_RISKS.includes(r)).sort()];

export interface PrescQuery { q: string; risk: string; page: number }
export function queryFrom(p: URLSearchParams, risks: readonly string[] | null = null): PrescQuery {
	const page = Number(p.get('page'));
	const risk = p.get('risk') ?? '';
	return { q: p.get('q') ?? '', risk: risks && risk && !risks.includes(risk) ? '' : risk, page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}
export function urlNotes(p: URLSearchParams, risks: readonly string[], pages: number): string[] {
	const notes: string[] = [];
	const risk = p.get('risk') ?? '';
	if (risk && !risks.includes(risk)) notes.push(`The risk filter '${risk}' in the link matches no risk in this case and was ignored: every risk is shown.`);
	for (const k of ['q', 'risk', 'page']) if (p.getAll(k).length > 1) notes.push(`The link gives '${k}' ${p.getAll(k).length} times; only the first is used.`);
	const raw = p.get('page');
	if (raw !== null && raw !== '') {
		const n = Number(raw);
		if (!Number.isSafeInteger(n) || n < 1) notes.push(`The page '${raw}' in the link is not a page number: page 1 is shown.`);
		else if (n > pages) notes.push(`The link asks for page ${n}, but there ${pages === 1 ? 'is 1 page' : `are ${pages} pages`}: the last page is shown.`);
	}
	return notes;
}
export function paramsFrom(q: PrescQuery): URLSearchParams {
	const p = new URLSearchParams();
	if (q.q) p.set('q', q.q);
	if (q.risk) p.set('risk', q.risk);
	if (q.page > 1) p.set('page', String(q.page));
	return p;
}

export function filterRows(rows: readonly PrescRow[], q: Pick<PrescQuery, 'q' | 'risk'>): PrescRow[] {
	const needle = q.q.toLowerCase();
	return rows.filter((r) => (!needle || `${r.no} ${r.ref}`.toLowerCase().includes(needle)) && (!q.risk || r.risk === q.risk));
}

export interface Page<T> { slice: T[]; page: number; pages: number; total: number; from: number; to: number }
export function paginate<T>(arr: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
	const total = arr.length;
	const pages = Math.max(1, Math.ceil(total / size));
	const p = Math.min(Math.max(1, page), pages);
	return { slice: arr.slice((p - 1) * size, (p - 1) * size + size), page: p, pages, total, from: total ? (p - 1) * size + 1 : 0, to: Math.min(p * size, total) };
}

export const PRESC_COLUMNS = ['ref', 'no', 'date', 'prescDate', 'risk'] as const;
export const prescriptionCsv = (rows: readonly PrescRow[]) => toCSV([[...PRESC_COLUMNS], ...rows.map((r) => PRESC_COLUMNS.map((k) => r[k]))]);

export type AsOf = 'passed' | 'not-reached' | 'no-date';
export const asOfStatus = (r: PrescRow, asOf: string): AsOf => (!isIsoDate(r.prescDate) ? 'no-date' : r.prescDate < asOf ? 'passed' : 'not-reached');
export const AS_OF_TEXT: Record<AsOf, string> = { passed: '3-yr date passed', 'not-reached': '3-yr date not reached', 'no-date': 'no valid date' };

export interface Arithmetic { rows: number; plusThree: number; leapInvoices: number; leapMovedTo28: number; passed: number; asOf: string }
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
export function summaryCheck(s: PrescSummary, rows: readonly PrescRow[]): SummaryCheck {
	const reliesCount = rows.filter((r) => r.risk === RELIES).length;
	return { totalMatches: s.total === rows.length, reliesMatches: s.reliesOnInterruption === reliesCount, reliesCount };
}
