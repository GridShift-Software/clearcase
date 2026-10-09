// Helpers shared by the evidence views (GRS-14, CC-04). Browser-safe and pure: the routes import them, the tests
// call them directly. v5 wording and semantics are cited by view-checklist line where they copy the source.
export { statusLabel } from '../../local-case/chronology.ts';

/** v5 cleanName (L439): drop a leading '(n) ' and a .pdf/.eml/.msg extension. */
export const cleanName = (f: string | null | undefined) => String(f ?? '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

/** v5 date cell: the source value, or '—' when undated. */
export const dateCell = (d: string | null | undefined) => d || '—';

export interface Page<T> { slice: T[]; page: number; pages: number; total: number; from: number; to: number }
/** v5 paginate (L305-306): clamps the page into range; from/to are 1-based and 0 for an empty list. */
export function paginate<T>(arr: readonly T[], page: number, size: number): Page<T> {
	const total = arr.length;
	const pages = Math.max(1, Math.ceil(total / size));
	const p = Math.min(Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1), pages);
	return { slice: arr.slice((p - 1) * size, (p - 1) * size + size), page: p, pages, total, from: total ? (p - 1) * size + 1 : 0, to: Math.min(p * size, total) };
}
/** A page number from a URL parameter: a positive integer, else 1. */
export const pageParam = (s: string | null) => (s && /^[1-9]\d{0,6}$/.test(s) ? Number(s) : 1);

/** The Doc cell of a document row: v5's 'open ↗' when the original is in the case folder (the link opens the
 *  document page, whose Open control is the two-click flow), else the original's state. */
export const docLabel = (file: string | null | undefined) => (file === 'present' ? 'open ↗' : file || 'missing');

/** A user-visible count: v5 toLocaleString in English grouping. */
export const n = (x: number) => x.toLocaleString('en');
