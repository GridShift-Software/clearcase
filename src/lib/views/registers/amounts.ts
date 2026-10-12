// The registers' amount grammar (GRS-17, CC-07 r2): disbursement amounts and timesheet rates in integer cents,
// timesheet hours in integer hundredths, with exact products and sums (BigInt) rounded once, half-up. v5 parsed these
// with fmtR's strip-to-digits and parseFloat (S-disbursements_tab-1, S-timesheet_tab-3), so '1 500,50' showed
// R 150 050.00 and hours '2,5' counted as 2; the app refuses such text visibly and keeps it as typed. The shared
// fmtR/money only format: they are given a 2-dp string, never a float. Browser-safe.

/** A disbursement amount (a credit may be negative), an hourly rate, or a number of hours. */
export type AmountKind = 'signed-money' | 'rate' | 'hours';
/** What a typed amount field holds: nothing (''), a value in hundredths of its unit, or text the grammar refuses. */
export type Parsed = { kind: 'empty' } | { kind: 'ok'; units: bigint } | { kind: 'bad'; why: string };

/**
 * The size bounds, as integer digits: an amount below R 1 000 000 000 000, a rate below R 10 000 000 an hour, hours
 * below 10 000. Value (hours × rate) then stays below R 100 000 000 000, inside fmtR's exact range.
 */
export const BOUND: Readonly<Record<AmountKind, number>> = { 'signed-money': 12, rate: 7, hours: 4 };

// an optional R and space (the app's own 'R 1 000.00'), digits plain or grouped by threes with one kind of separator
// (space or comma, CC-06's grammar), then '.' and at most 2 decimals; hours are plain digits and at most 2 decimals
const MONEY = /^(-)?(?:R ?)?(\d+|\d{1,3}(?: \d{3})+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;
const HOURS = /^()(\d+)(?:\.(\d{1,2}))?$/;

/** Parse one typed field; surrounding spaces are ignored, the stored text stays as typed. */
export function parseAmount(raw: string, kind: AmountKind): Parsed {
	const s = raw.trim();
	if (s === '') return { kind: 'empty' };
	const m = (kind === 'hours' ? HOURS : MONEY).exec(s);
	if (!m) return { kind: 'bad', why: badWhy(s, kind) };
	const [, neg, int, dec] = m;
	if (neg && kind !== 'signed-money') return { kind: 'bad', why: 'cannot be negative' };
	const digits = int!.replace(/[ ,]/g, '').replace(/^0+(?=\d)/, '');
	if (digits.length > BOUND[kind]) return { kind: 'bad', why: `must be below ${kind === 'hours' ? '' : 'R '}${grouped(`1${'0'.repeat(BOUND[kind])}`)}` };
	const units = BigInt(digits) * 100n + BigInt((dec ?? '').padEnd(2, '0'));
	return { kind: 'ok', units: neg ? -units : units };
}

function badWhy(s: string, kind: AmountKind): string {
	if (/^[-−]/.test(s)) return kind === 'signed-money' ? 'can start with one minus sign (-) only' : 'cannot be negative';
	if (/,\d{1,2}$/.test(s)) return 'uses a decimal comma; write the decimals after a point (1 500.50)';
	if (/\de[+-]?\d/i.test(s)) return 'cannot be written with an exponent';
	if (/\.\d{3,}$/.test(s)) return 'can have at most 2 decimals';
	return kind === 'hours' ? 'must be a number of hours, such as 1.5' : 'must be an amount in rand, such as 1 500.50 or R 1 500.50';
}

/** Digits grouped by threes with spaces, as fmtR groups them. */
const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Hundredths as a plain 2-dp string ('-1500.05'), the only form handed to fmtR. */
export function twoDp(units: bigint): string {
	const a = units < 0n ? -units : units;
	return `${units < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Divide and round once, exact half-up (away from zero on a tie). */
export function roundDiv(n: bigint, d: bigint): bigint {
	const q = ((n < 0n ? -n : n) + d / 2n) / d;
	return n < 0n ? -q : q;
}

/** Value = hours × rate in cents, rounded once half-up; null when either part does not parse (an empty part is 0, as v5). */
export function valueCents(hours: string, rate: string): bigint | null {
	const h = parseAmount(hours, 'hours'), r = parseAmount(rate, 'rate');
	if (h.kind === 'bad' || r.kind === 'bad') return null;
	return roundDiv((h.kind === 'ok' ? h.units : 0n) * (r.kind === 'ok' ? r.units : 0n), 100n);
}

/** A sum of hours (in hundredths) as v5's tile shows it: one decimal, rounded once half-up. */
export function hoursTile(hundredths: bigint): string {
	const t = roundDiv(hundredths, 10n);
	const a = t < 0n ? -t : t;
	return `${t < 0n ? '-' : ''}${a / 10n}.${a % 10n}`;
}
