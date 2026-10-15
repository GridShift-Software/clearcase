const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export function parseFixedNow(value: string | null | undefined): Date | null {
	if (value === undefined || value === null || value === '') return null;
	const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
	const real = new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d; // no 30 February rolling into March
	const ms = ISO.test(value) && real ? Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value) : NaN;
	if (Number.isNaN(ms)) throw new Error(`CLEARCASE_FIXED_NOW must be an ISO-8601 date or date-time with an offset, e.g. 2030-01-31T09:00:00Z; got ${JSON.stringify(value.slice(0, 40))}`);
	return new Date(ms);
}

let browserFixed: string | null = null;
export const useFixedNow = (iso: string | null) => { browserFixed = iso; };

export const fixedNowSetting = (): string | null =>
	typeof process !== 'undefined' && process.env ? (process.env.CLEARCASE_FIXED_NOW || null) : browserFixed;

export const now = (): Date => parseFixedNow(fixedNowSetting()) ?? new Date();
