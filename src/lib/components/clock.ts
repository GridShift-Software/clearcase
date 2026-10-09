// The one clock seam for dates the app shows or stamps (BA-04 views, deadline countdowns, note and activation times).
// Production reads the real clock. A test or verification run fixes it with CLEARCASE_FIXED_NOW, an ISO-8601 date or
// date-time with an explicit offset ('2030-01-31' or '2030-01-31T09:00:00Z'); unset (the default) means the real clock.
// An invalid value fails loudly instead of silently falling back. Browser-safe: in the browser the root layout passes
// the server's setting in with useFixedNow(), so server and browser agree. Timers, deadlines, lock stamps and backup
// file names keep the real clock (Date.now/performance.now): they are not displayed dates.
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Parse a CLEARCASE_FIXED_NOW value: null when unset or empty; throws when set to anything but ISO-8601. */
export function parseFixedNow(value: string | null | undefined): Date | null {
	if (value === undefined || value === null || value === '') return null;
	const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
	const real = new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d; // no 30 February rolling into March
	const ms = ISO.test(value) && real ? Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value) : NaN;
	if (Number.isNaN(ms)) throw new Error(`CLEARCASE_FIXED_NOW must be an ISO-8601 date or date-time with an offset, e.g. 2030-01-31T09:00:00Z; got ${JSON.stringify(value.slice(0, 40))}`);
	return new Date(ms);
}

let browserFixed: string | null = null;
/** The browser side of the seam: the root layout hands over the server's setting (null for the real clock). */
export const useFixedNow = (iso: string | null) => { browserFixed = iso; };

/** The raw setting in force: the environment on the server, the server's value in the browser. */
export const fixedNowSetting = (): string | null =>
	typeof process !== 'undefined' && process.env ? (process.env.CLEARCASE_FIXED_NOW || null) : browserFixed;

/** The current time for anything displayed or stamped: CLEARCASE_FIXED_NOW when set, else the real clock. */
export const now = (): Date => parseFixedNow(fixedNowSetting()) ?? new Date();
