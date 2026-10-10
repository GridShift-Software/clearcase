// Exact money arithmetic for the quantum views (GRS-16). Every amount is parsed once, with one grammar, into an
// integer (BigInt): typed amounts into cents, imported amounts into ten-thousandths of a rand (records.ts `Amount`
// allows 4 decimals). Sums and differences are exact; a result is rounded once, exact half-up (away from zero) to
// cents, and handed to the shared fmtR/money only as a 2-dp string, for formatting. Rules and their reasons:
// docs/reference/calculation-differences.md. Browser-safe and pure.

/** A parse result: the value, or a visible error that the caller shows beside the typed text (which it keeps). */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Largest whole-rand part a typed amount may have: 13 digits keeps every cent value a safe integer. */
export const MAX_RAND_DIGITS = 13;

/**
 * The typed-amount grammar: an optional `R` and an optional space, then digits, with one kind of separator (space or
 * comma) only between groups of three, and an optional `.` with one or two decimals. `R 1 000.00` (the app's own
 * format), `R1,000`, `1000` and `1000.5` parse; a comma decimal (`1 000,50`), a negative, a sign, a currency word,
 * mixed separators or text do not.
 */
const TYPED = /^(?:R ?)?(\d{1,3}(?:( |,)\d{3})(?:\2\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/** A typed amount (as the user wrote it) in cents, or a visible error. Leading and trailing spaces are ignored. */
export function parseAmount(text: string): Parsed<bigint> {
	const t = text.trim();
	if (t === '') return { ok: false, error: 'Enter an amount.' };
	if (/^-|^R ?-/.test(t)) return { ok: false, error: 'A negative amount is not accepted.' };
	const m = TYPED.exec(t);
	if (!m) {
		if (/^(?:R ?)?[\d ,]*\d,\d{1,2}$/.test(t)) return { ok: false, error: 'Use a full stop for cents (a comma decimal such as 1 000,50 is ambiguous).' };
		return { ok: false, error: 'Not an amount: write digits, optionally with R, spaces or commas between thousands and a full stop before cents.' };
	}
	const rand = m[1]!.replace(/[ ,]/g, '');
	if (rand.replace(/^0+(?=\d)/, '').length > MAX_RAND_DIGITS) return { ok: false, error: `Amounts above ${MAX_RAND_DIGITS} digits of rand are not accepted.` };
	return { ok: true, value: BigInt(rand) * 100n + BigInt((m[3] ?? '').padEnd(2, '0')) };
}

/** Imported `Amount` values (records.ts): optional minus, up to 15 digits, up to 4 decimals; empty is "no value". */
const IMPORTED = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/;

/** An imported amount in ten-thousandths of a rand; null for the empty string or text outside the Amount shape. */
export function importedUnits(s: string | null | undefined): bigint | null {
	const m = IMPORTED.exec(s ?? '');
	if (!m) return null;
	const v = BigInt(m[2]!) * 10000n + BigInt((m[3] ?? '').padEnd(4, '0'));
	return m[1] ? -v : v;
}

/** n / d rounded half away from zero (d > 0). */
export function divRound(n: bigint, d: bigint): bigint {
	if (d <= 0n) throw new RangeError('divRound: the divisor must be positive');
	const neg = n < 0n;
	const a = neg ? -n : n;
	const q = (2n * a + d) / (2n * d);
	return neg ? -q : q;
}

/** Ten-thousandths to cents, exact half-up (away from zero). `1.005` becomes 1.01, where `toFixed(2)` gives 1.00. */
export const unitsToCents = (u: bigint): bigint => divRound(u, 100n);
export const centsToUnits = (c: bigint): bigint => c * 100n;

/** Cents as a plain 2-dp decimal string ('-1234.50'), the only form passed to fmtR. */
export function centsText(c: bigint): string {
	const neg = c < 0n;
	const a = neg ? -c : c;
	return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/**
 * A floating-point result (compound interest, settlement discounting) in cents: the double's exact value rounded half
 * away from zero, which is what `Math.abs(x).toFixed(2)` computes; null when not finite.
 */
export function floatToCents(x: number): bigint | null {
	if (!Number.isFinite(x)) return null;
	const [i, d] = Math.abs(x).toFixed(2).split('.');
	const c = BigInt(i!) * 100n + BigInt(d!);
	return x < 0 ? -c : c;
}

/** Cents as a JavaScript number of rand, for the fractional-power formulas only (exact for safe-integer cents). */
export const centsToNumber = (c: bigint): number => Number(c) / 100;

/** The sum of imported amounts in ten-thousandths; empty and malformed values count as zero, as v5's `parseFloat||0`. */
export const sumImported = (values: readonly (string | null | undefined)[]): bigint => values.reduce((a, s) => a + (importedUnits(s) ?? 0n), 0n);

/** A non-negative decimal typed into a rate or model field ('10', '10.5'); returned as an exact fraction. */
export interface Decimal { num: bigint; den: bigint; text: string; value: number }
const DECIMAL = /^(\d{1,9})(?:\.(\d{1,6}))?$/;
export function parseDecimal(text: string, what = 'a number'): Parsed<Decimal> {
	const t = text.trim();
	if (t === '') return { ok: false, error: `Enter ${what}.` };
	if (t.startsWith('-')) return { ok: false, error: `${what[0]!.toUpperCase()}${what.slice(1)} cannot be negative.` };
	const m = DECIMAL.exec(t);
	if (!m) return { ok: false, error: `Not ${what}: write digits with an optional full stop and decimals (no separators or symbols).` };
	const dec = m[2] ?? '';
	const num = BigInt(m[1]! + dec);
	const den = 10n ** BigInt(dec.length);
	// Number(num) / Number(den) is the correctly rounded double of the decimal, the same double parseFloat gives
	return { ok: true, value: { num, den, text: t, value: Number(num) / Number(den) } };
}
