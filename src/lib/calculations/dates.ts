
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MIN_YEAR = 1000;
export const MAX_YEAR = 9999;

export function ymd(s: string | null | undefined): [number, number, number] | null {
	const m = ISO.exec(s ?? '');
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
	return [y, mo, d];
}
export const isIsoDate = (s: string | null | undefined) => ymd(s) !== null;
export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number) => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function dateProblem(label: string, s: string): string {
	if (ymd(s)) return '';
	if (s.trim() === '') return `${label}: enter a date.`;
	const y = /^(\d+)-\d{2}-\d{2}$/.exec(s.trim());
	if (y && (y[1]!.length !== 4 || Number(y[1]) < MIN_YEAR)) return `${label}: '${s}' is outside the accepted years. Enter a year from ${MIN_YEAR} to ${MAX_YEAR}.`;
	return `${label}: '${s}' is not a calendar date. Enter a date as YYYY-MM-DD with a year from ${MIN_YEAR} to ${MAX_YEAR}.`;
}

/** Days from 1970-01-01 to a proleptic Gregorian date, by arithmetic (H. Hinnant's days_from_civil). */
function dayNumber(y: number, m: number, d: number): number {
	const yy = m <= 2 ? y - 1 : y;
	const era = Math.floor(yy / 400);
	const yoe = yy - era * 400;
	const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

export function daysBetween(from: string, to: string): number | null {
	const a = ymd(from), b = ymd(to);
	if (!a || !b) return null;
	return dayNumber(...b) - dayNumber(...a);
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

export const utcDate = (t: Date) => t.toISOString().slice(0, 10);

/**
 * The calendar date of an instant in South Africa (Africa/Johannesburg, SAST): UTC+2 all year, since South Africa has
 * no daylight saving, so it is the UTC date of the instant two hours later, whatever the host's time zone (CC-06 r2, D9).
 */
export const saDate = (t: Date) => new Date(t.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
