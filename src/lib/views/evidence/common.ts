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
/** A URL value echoed in a message, shortened. */
export const echo = (v: string) => `“${v.length > 40 ? `${v.slice(0, 40)}…` : v}”`;
/** Why the page shown is not the page the URL asks for (not a page number, or past the last page), or null. */
export function pageNotice(raw: string | null, shown: Pick<Page<unknown>, 'page' | 'pages'>): string | null {
	if (raw === null) return null;
	if (!/^[1-9]\d{0,6}$/.test(raw)) return `The requested page ${echo(raw)} is not a page number; page ${shown.page} is shown.`;
	return Number(raw) === shown.page ? null : `Page ${raw} does not exist here; page ${shown.page} of ${shown.pages} is shown.`;
}

/**
 * The longest Text, Sender or filter value accepted (D13): the controls stop there, and a longer value from a URL is
 * refused with a message (a URL beyond about 16 KiB is refused by the server before the app sees it).
 */
export const MAX_TEXT = 500;

/**
 * A bundle as a URL or select value (D4). Any string is a bundle name, including ''; the empty name is `~`, and a name
 * that starts with `~` gains one more, so every name has its own value and none is '' (which means no bundle chosen).
 */
export const bundleParam = (name: string) => (name === '' ? '~' : name.startsWith('~') ? `~${name}` : name);
/** A bundle's visible name: the empty name reads '(no bundle)' (its value stays apart from a bundle so named). */
export const bundleLabel = (name: string) => name || '(no bundle)';

/** The Doc cell of a document row: v5's 'open ↗' when the original is in the case folder (the link opens the
 *  document page, whose Open control is the two-click flow), else the original's state. */
export const docLabel = (file: string | null | undefined) => (file === 'present' ? 'open ↗' : file || 'missing');

/** A user-visible count: v5 toLocaleString in English grouping. */
export const n = (x: number) => x.toLocaleString('en');
