// Shared display helpers for views. Browser-safe. Imported values are displayed, never reinterpreted.

/** v5 fmtR: 'R 1 234 567.50', '-R 5.00'; '' when the value is not a finite number. */
export function fmtR(v: string | number): string {
	const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
	if (!Number.isFinite(n)) return '';
	const [int, dec] = Math.abs(n).toFixed(2).split('.');
	return `${n < 0 ? '-' : ''}R ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${dec}`;
}
/** v5 money: '' for empty or non-numeric source values. */
export const money = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '' : fmtR(v));

/** BA-04: what is known about a date's basis; never inferred from the value. */
export function dateBasis(r: { date: string; dateType: string | null; dateSource: string | null }): string {
	if (r.date === '') return 'undated: the source gives no date';
	const parts = [r.dateType ? `type ${r.dateType}` : null, r.dateSource ? `source ${r.dateSource}` : null].filter(Boolean);
	return parts.length ? parts.join(', ') : 'basis unknown: the source gives no date type or provenance';
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
