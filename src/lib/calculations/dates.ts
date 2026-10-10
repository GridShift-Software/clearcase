// Calendar-date arithmetic for the quantum views (GRS-16). Dates are ISO `YYYY-MM-DD` calendar dates counted in UTC,
// so a day count never depends on the host time zone or daylight saving (v5 subtracted local-time dates:
// S-interest_calc_tab-4). Browser-safe and pure.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

/** [year, month 1-12, day] of a real calendar date, else null ('2026-02-30' and '2026-13-01' are not dates). */
export function ymd(s: string | null | undefined): [number, number, number] | null {
	const m = ISO.exec(s ?? '');
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
	return [y, mo, d];
}
export const isIsoDate = (s: string | null | undefined) => ymd(s) !== null;
export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number) => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Whole days from `from` to `to` on the calendar (negative when reversed); null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
	const a = ymd(from), b = ymd(to);
	if (!a || !b) return null;
	return (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY;
}

/**
 * The same day `n` calendar years later. 29 February in a year whose target is not a leap year becomes 28 February
 * (the arithmetic v5's prescription dates show); every other day, including the 31st, keeps its month and day.
 * Arithmetic only: whether the law counts it this way is not decided here.
 */
export function addYears(date: string, n: number): string | null {
	const p = ymd(date);
	if (!p) return null;
	const y = p[0] + n;
	return iso(y, p[1], Math.min(p[2], daysInMonth(y, p[1])));
}

/** The calendar date of an instant in UTC (the as-of date of `now()`). */
export const utcDate = (t: Date) => t.toISOString().slice(0, 10);
