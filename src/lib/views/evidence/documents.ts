// Documents (v5 documents, L448-470): the document rows of one bundle, a filter, type tallies and 60-row pages.
// Browser-safe and pure. Rows come from the document-row contract (the server reads them with evidenceRows).
//  * Every imported bundle is selectable, in order of first appearance (S-bundle4, S-documents-1, corrected); the
//    button counts are counted from the rows the table shows (S-documents-2, corrected).
//  * The filter is v5's: a case-insensitive substring of filename, ref, subject and excerpt (not sender).
//  * Order: by type, then date, undated first within a type (BA-17: the order the label states). v5 compared the
//    concatenated type and date, which interleaves a type with another that it prefixes (S-documents-3).
import type { ChronologyListRow } from '../../local-case/model.ts';
import { cleanName, paginate, type Page } from './common.ts';
import { money } from '../../components/format.ts';

export const PAGE_SIZE = 60;
const collator = new Intl.Collator('en-US');

export interface DocumentsQuery { bundle: string | null; q: string; page: number }
export interface DocumentLine { ref: string; type: string; date: string; title: string; amount: string; textStatus: string; file: string }
export interface DocumentsModel {
	bundles: { name: string; count: number }[];
	bundle: string;
	q: string;
	types: { type: string; count: number }[];
	page: Page<DocumentLine>;
	/** whether the requested bundle is not one of the version's bundles (the first bundle is shown instead) */
	unknownBundle: boolean;
}

export const bundlesOf = (rows: readonly ChronologyListRow[]) => {
	const m = new Map<string, number>();
	for (const r of rows) m.set(r.bundle, (m.get(r.bundle) ?? 0) + 1);
	return [...m].map(([name, count]) => ({ name, count }));
};

export const matches = (r: ChronologyListRow, needle: string) => !needle || `${r.filename} ${r.ref} ${r.subject} ${r.excerpt}`.toLowerCase().includes(needle);

/** Type, then date (code units; '' first), then source order. */
export const byTypeThenDate = (a: ChronologyListRow, b: ChronologyListRow) => collator.compare(a.docType, b.docType) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.ord - b.ord;

export function documentsModel(rows: readonly ChronologyListRow[], query: DocumentsQuery): DocumentsModel {
	const bundles = bundlesOf(rows);
	const known = query.bundle !== null && bundles.some((b) => b.name === query.bundle);
	const bundle = known ? query.bundle! : (bundles[0]?.name ?? '');
	const needle = query.q.toLowerCase();
	const shown = rows.filter((r) => r.bundle === bundle && matches(r, needle));
	const tally = new Map<string, number>();
	for (const r of shown) tally.set(r.docType, (tally.get(r.docType) ?? 0) + 1);
	const types = [...tally].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([type, count]) => ({ type, count }));
	const sorted = [...shown].sort(byTypeThenDate);
	const p = paginate(sorted, query.page, PAGE_SIZE);
	return {
		bundles, bundle, q: query.q, types, unknownBundle: query.bundle !== null && !known,
		page: { ...p, slice: p.slice.map((r) => ({ ref: r.ref, type: r.docType, date: r.date, title: r.subject || cleanName(r.filename), amount: money(r.amount), textStatus: r.textStatus, file: r.file })) },
	};
}
