export { statusLabel } from '../../local-case/chronology.ts';

export const cleanName = (f: string | null | undefined) => String(f ?? '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

export const dateCell = (d: string | null | undefined) => d || '—';

export interface Page<T> { slice: T[]; page: number; pages: number; total: number; from: number; to: number }
export function paginate<T>(arr: readonly T[], page: number, size: number): Page<T> {
	const total = arr.length;
	const pages = Math.max(1, Math.ceil(total / size));
	const p = Math.min(Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1), pages);
	return { slice: arr.slice((p - 1) * size, (p - 1) * size + size), page: p, pages, total, from: total ? (p - 1) * size + 1 : 0, to: Math.min(p * size, total) };
}
export const pageParam = (s: string | null) => (s && /^[1-9]\d{0,6}$/.test(s) ? Number(s) : 1);
export const echo = (v: string) => `“${v.length > 40 ? `${v.slice(0, 40)}…` : v}”`;
export function pageNotice(raw: string | null, shown: Pick<Page<unknown>, 'page' | 'pages'>): string | null {
	if (raw === null) return null;
	if (!/^[1-9]\d{0,6}$/.test(raw)) return `The requested page ${echo(raw)} is not a page number; page ${shown.page} is shown.`;
	return Number(raw) === shown.page ? null : `Page ${raw} does not exist here; page ${shown.page} of ${shown.pages} is shown.`;
}

export const MAX_TEXT = 500;

export const bundleParam = (name: string) => (name === '' ? '~' : name.startsWith('~') ? `~${name}` : name);
export const bundleLabel = (name: string) => name || '(no bundle)';

export const docLabel = (file: string | null | undefined) => (file === 'present' ? 'open ↗' : file || 'missing');

export const n = (x: number) => x.toLocaleString('en');
