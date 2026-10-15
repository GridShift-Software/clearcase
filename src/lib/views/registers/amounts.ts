
export type AmountKind = 'signed-money' | 'rate' | 'hours';
export type Parsed = { kind: 'empty' } | { kind: 'ok'; units: bigint } | { kind: 'bad'; why: string };

export const BOUND: Readonly<Record<AmountKind, number>> = { 'signed-money': 12, rate: 7, hours: 4 };

const MONEY = /^(-)?(?:R ?)?(\d+|\d{1,3}(?: \d{3})+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;
const HOURS = /^()(\d+)(?:\.(\d{1,2}))?$/;

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

const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function twoDp(units: bigint): string {
	const a = units < 0n ? -units : units;
	return `${units < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

export function roundDiv(n: bigint, d: bigint): bigint {
	const q = ((n < 0n ? -n : n) + d / 2n) / d;
	return n < 0n ? -q : q;
}

export function valueCents(hours: string, rate: string): bigint | null {
	const h = parseAmount(hours, 'hours'), r = parseAmount(rate, 'rate');
	if (h.kind === 'bad' || r.kind === 'bad') return null;
	return roundDiv((h.kind === 'ok' ? h.units : 0n) * (r.kind === 'ok' ? r.units : 0n), 100n);
}

export function hoursTile(hundredths: bigint): string {
	const t = roundDiv(hundredths, 10n);
	const a = t < 0n ? -t : t;
	return `${t < 0n ? '-' : ''}${a / 10n}.${a % 10n}`;
}
