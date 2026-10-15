import type { ChronologyListRow } from '../../local-case/model.ts';
import { MAX_TEXT, bundleLabel, bundleParam, cleanName, pageNotice, pageParam, paginate, type Page } from './common.ts';
import { money } from '../../components/format.ts';

export const PAGE_SIZE = 60;
const collator = new Intl.Collator('en-US');

export interface DocumentsQuery { bundle: string | null; q: string; page: number | string | null }
export interface DocumentLine { ref: string; type: string; date: string; title: string; amount: string; textStatus: string; file: string }
export interface DocumentsModel {
	bundles: { name: string; value: string; label: string; count: number }[];
	bundle: string;
	q: string;
	types: { type: string; count: number }[];
	page: Page<DocumentLine>;
	unknownBundle: boolean;
	filterTooLong: boolean;
	pageNotice: string | null;
}

export const bundlesOf = (rows: readonly ChronologyListRow[]) => {
	const m = new Map<string, number>();
	for (const r of rows) m.set(r.bundle, (m.get(r.bundle) ?? 0) + 1);
	return [...m].map(([name, count]) => ({ name, count }));
};

export const matches = (r: ChronologyListRow, needle: string) => !needle || `${r.filename} ${r.ref} ${r.subject} ${r.excerpt}`.toLowerCase().includes(needle);

export const byTypeThenDate = (a: ChronologyListRow, b: ChronologyListRow) => collator.compare(a.docType, b.docType) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.ord - b.ord;

export function documentsModel(rows: readonly ChronologyListRow[], query: DocumentsQuery): DocumentsModel {
	const bundles = bundlesOf(rows).map((b) => ({ ...b, value: bundleParam(b.name), label: bundleLabel(b.name) }));
	const asked = query.bundle !== null ? bundles.find((b) => b.value === query.bundle) : undefined;
	const bundle = asked ? asked.name : (bundles[0]?.name ?? '');
	const filterTooLong = query.q.length > MAX_TEXT;
	const needle = filterTooLong ? '' : query.q.toLowerCase();
	const shown = rows.filter((r) => r.bundle === bundle && matches(r, needle));
	const tally = new Map<string, number>();
	for (const r of shown) tally.set(r.docType, (tally.get(r.docType) ?? 0) + 1);
	const types = [...tally].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([type, count]) => ({ type, count }));
	const sorted = [...shown].sort(byTypeThenDate);
	const p = paginate(sorted, typeof query.page === 'number' ? query.page : pageParam(query.page), PAGE_SIZE);
	return {
		bundles, bundle, q: query.q, types, unknownBundle: query.bundle !== null && !asked, filterTooLong, pageNotice: typeof query.page === 'number' ? null : pageNotice(query.page, p),
		page: { ...p, slice: p.slice.map((r) => ({ ref: r.ref, type: r.docType, date: r.date, title: r.subject || cleanName(r.filename), amount: money(r.amount), textStatus: r.textStatus, file: r.file })) },
	};
}
