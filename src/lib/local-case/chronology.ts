// Chronology filtering and sorting, shared by the view, the CSV export and the tests, and the page's full-list fetch.
// Browser-safe. Semantics follow v5 chronFiltered/sortChron (view checklist, chronology): filters are ANDed exact
// matches on bundle, type, text status and year (the date's first four digits), plus a case-insensitive substring over
// filename, ref, subject, sender and excerpt. Sorts compare code units (date, ref, type, bundle) or parseFloat with
// empty = 0 (amount), and are stable: ties keep the source order in both directions. Undated rows ('' dates) sort first
// ascending. Every imported bundle is selectable (rewrite of S-chronology-1).
import type { FacetCounts, FacetsShard, ListPage } from '../views/payloads/list.ts';
import type { ChronologyListRow } from './model.ts';

export type SortKey = 'date' | 'ref' | 'docType' | 'bundle' | 'amount';
export const SORT_KEYS: readonly SortKey[] = ['date', 'ref', 'docType', 'bundle', 'amount'];
export interface ChronologyQuery { q: string; bundle: string; type: string; year: string; status: string; sort: SortKey; dir: 1 | -1 }
export const DEFAULT_QUERY: ChronologyQuery = Object.freeze({ q: '', bundle: '', type: '', year: '', status: '', sort: 'date', dir: 1 });
const FILTERS = ['q', 'bundle', 'type', 'year', 'status'] as const;
type Filters = Pick<ChronologyQuery, (typeof FILTERS)[number]>;

const amount = (s: string) => { const n = parseFloat(s); return Number.isNaN(n) ? 0 : n; };

export function filterRows(rows: readonly ChronologyListRow[], f: Filters): ChronologyListRow[] {
	const needle = f.q.toLowerCase();
	return rows.filter((r) =>
		(!f.bundle || r.bundle === f.bundle) && (!f.type || r.docType === f.type) && (!f.status || r.textStatus === f.status) &&
		(!f.year || (YEAR.test(r.date) && r.date.slice(0, 4) === f.year)) &&
		(!needle || `${r.filename} ${r.ref} ${r.subject} ${r.sender} ${r.excerpt}`.toLowerCase().includes(needle)));
}

export function sortRows(rows: readonly ChronologyListRow[], sort: SortKey, dir: 1 | -1): ChronologyListRow[] {
	const out = [...rows].sort((a, b) => a.ord - b.ord);
	const cmp = sort === 'amount'
		? (a: ChronologyListRow, b: ChronologyListRow) => amount(a.amount) - amount(b.amount)
		: (a: ChronologyListRow, b: ChronologyListRow) => (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0);
	return out.sort((a, b) => (cmp(a, b) * dir) || a.ord - b.ord);
}

export const queryRows = (rows: readonly ChronologyListRow[], q: ChronologyQuery) => sortRows(filterRows(rows, q), q.sort, q.dir);

export const isFiltered = (q: ChronologyQuery) => FILTERS.some((k) => q[k] !== '');
/** Every filter cleared; the sort stays. */
export const clearFilters = (q: ChronologyQuery): ChronologyQuery => ({ ...q, q: '', bundle: '', type: '', year: '', status: '' });

const YEAR = /^\d{4}/;
function counts(values: Iterable<string>): FacetCounts {
	const m = new Map<string, number>();
	for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
	return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
/** The filter options with their counts, as the publisher writes `list/facets.json` for hosted. */
export const facetsOf = (rows: readonly ChronologyListRow[]): FacetsShard => ({
	bundles: counts(rows.map((r) => r.bundle)),
	docTypes: counts(rows.map((r) => r.docType)),
	textStatuses: counts(rows.map((r) => r.textStatus)),
	years: counts(rows.flatMap((r) => (YEAR.test(r.date) ? [r.date.slice(0, 4)] : []))),
});

/** A list answer's rows: a `ListPage` (hosted pages, `?all=1`) or the local API's whole array. */
export const listRowsOf = (body: ListPage | ChronologyListRow[]): ChronologyListRow[] => (Array.isArray(body) ? body : body.rows);

export const optionsOf = (rows: readonly ChronologyListRow[], f: 'bundle' | 'docType' | 'textStatus') => [...new Set(rows.map((r) => r[f]))].sort();

/** The package contract's text-status vocabulary, in v5's filter order (results-package.md). */
export const TEXT_STATUSES: readonly string[] = ['extracted', 'ocr', 'none', 'pending'];
/** The text-status filter options: the whole vocabulary, as v5 offers it, then any other status given. */
export const statusChoices = (statuses: readonly string[]) => [...TEXT_STATUSES, ...[...new Set(statuses)].sort().filter((s) => !TEXT_STATUSES.includes(s))];
/** The text-status filter options: the whole vocabulary, then any other status a row carries. */
export const statusOptions = (rows: readonly ChronologyListRow[]) => statusChoices(rows.map((r) => r.textStatus));

/** v5's text-status wording (statusBadge): a row without text reads 'scan · none'; an empty status reads '—'. */
export const statusLabel = (s: string) => (s === 'none' ? 'scan · none' : s || '—');

/** v5's excerpt preview (drawChron): the first 140 UTF-16 code units, always followed by an ellipsis. */
export const excerptPreview = (s: string) => (s ? `${s.slice(0, 140)}…` : '');

export function queryFromParams(p: URLSearchParams): ChronologyQuery {
	const sort = p.get('sort') as SortKey | null;
	return {
		q: p.get('q') ?? '', bundle: p.get('bundle') ?? '', type: p.get('type') ?? '', year: p.get('year') ?? '', status: p.get('status') ?? '',
		sort: sort && SORT_KEYS.includes(sort) ? sort : 'date', dir: p.get('dir') === 'desc' ? -1 : 1,
	};
}
export function paramsFromQuery(q: ChronologyQuery): URLSearchParams {
	const p = new URLSearchParams();
	for (const k of FILTERS) if (q[k]) p.set(k, q[k]);
	if (q.sort !== 'date') p.set('sort', q.sort);
	if (q.dir === -1) p.set('dir', 'desc');
	return p;
}

/** Every row of the list (`listHref?all=1`; the local API answers its whole array whatever the query). */
export async function allRows(listHref: string, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<ChronologyListRow[]> {
	const r = await fetch(`${listHref}?all=1`);
	if (!r.ok) throw new Error(`chronology list: ${r.status}`);
	return listRowsOf((await r.json()) as ListPage | ChronologyListRow[]);
}
