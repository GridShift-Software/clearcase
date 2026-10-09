// Chronology filtering and sorting, shared by the view, the CSV export and the tests. Browser-safe.
// Semantics follow v5 chronFiltered/sortChron (view checklist, chronology): filters are ANDed exact matches on bundle,
// type and text status, plus a case-insensitive substring over filename, ref, subject, sender and excerpt. Sorts
// compare code units (date, ref, type, bundle) or parseFloat with empty = 0 (amount), and are stable: ties keep the
// source order in both directions. Undated rows ('' dates) sort first ascending. Every imported bundle is
// selectable (rewrite of S-chronology-1).
import type { ChronologyListRow } from './model.ts';

export type SortKey = 'date' | 'ref' | 'docType' | 'bundle' | 'amount';
export const SORT_KEYS: readonly SortKey[] = ['date', 'ref', 'docType', 'bundle', 'amount'];
export interface ChronologyQuery { q: string; bundle: string; type: string; status: string; sort: SortKey; dir: 1 | -1 }
export const DEFAULT_QUERY: ChronologyQuery = Object.freeze({ q: '', bundle: '', type: '', status: '', sort: 'date', dir: 1 });

const amount = (s: string) => { const n = parseFloat(s); return Number.isNaN(n) ? 0 : n; };

export function filterRows(rows: readonly ChronologyListRow[], f: Pick<ChronologyQuery, 'q' | 'bundle' | 'type' | 'status'>): ChronologyListRow[] {
	const needle = f.q.toLowerCase();
	return rows.filter((r) =>
		(!f.bundle || r.bundle === f.bundle) && (!f.type || r.docType === f.type) && (!f.status || r.textStatus === f.status) &&
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

/** Every distinct value of a field, sorted by code unit, for the filter selects. */
export const optionsOf = (rows: readonly ChronologyListRow[], f: 'bundle' | 'docType' | 'textStatus') => [...new Set(rows.map((r) => r[f]))].sort();

/** Query <-> URL search params, so filters survive Back and reload (BA-14). Defaults are omitted. */
export function queryFromParams(p: URLSearchParams): ChronologyQuery {
	const sort = p.get('sort') as SortKey | null;
	return {
		q: p.get('q') ?? '', bundle: p.get('bundle') ?? '', type: p.get('type') ?? '', status: p.get('status') ?? '',
		sort: sort && SORT_KEYS.includes(sort) ? sort : 'date', dir: p.get('dir') === 'desc' ? -1 : 1,
	};
}
export function paramsFromQuery(q: ChronologyQuery): URLSearchParams {
	const p = new URLSearchParams();
	for (const k of ['q', 'bundle', 'type', 'status'] as const) if (q[k]) p.set(k, q[k]);
	if (q.sort !== 'date') p.set('sort', q.sort);
	if (q.dir === -1) p.set('dir', 'desc');
	return p;
}
