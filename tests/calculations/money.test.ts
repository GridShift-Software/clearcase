// The amount grammar and exact rounding (GRS-16): fixed literal inputs, zero and invalid inputs, 4-decimal imports.
import { describe, expect, it } from 'vitest';
import { fmtR } from '../../src/lib/components/format';
import { centsText, divRound, floatToCents, importedUnits, parseAmount, parseDecimal, sumImported, unitsToCents } from '../../src/lib/calculations/money';

const cents = (t: string) => { const r = parseAmount(t); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r.value; };
const refused = (t: string) => { const r = parseAmount(t); return r.ok ? null : r.error; };

describe('typed amounts', () => {
	it('parses the app\'s own format and the plain forms', () => {
		expect(cents('R 1 000.00')).toBe(100000n);
		expect(cents('R1,000')).toBe(100000n);
		expect(cents('1 000')).toBe(100000n);
		expect(cents('1,000,000.5')).toBe(100000050n);
		expect(cents('1000')).toBe(100000n);
		expect(cents('250.50')).toBe(25050n);
		expect(cents('  42  ')).toBe(4200n);
		expect(cents('R 0.01')).toBe(1n);
	});
	it('accepts zero', () => {
		expect(cents('0')).toBe(0n);
		expect(cents('R 0.00')).toBe(0n);
	});
	it('refuses text, negatives, comma decimals and malformed grouping, with a visible reason', () => {
		expect(refused('')).toMatch(/Enter an amount/);
		expect(refused('Synthetic entry 1')).toMatch(/Not an amount/);
		expect(refused('-5')).toMatch(/negative/);
		expect(refused('R -5')).toMatch(/negative/);
		expect(refused('1 000,50')).toMatch(/comma decimal/);
		expect(refused('12,5')).toMatch(/comma decimal/);
		expect(refused('1 00 000')).not.toBeNull();
		expect(refused('1,000 000')).not.toBeNull(); // mixed separators
		expect(refused('1.005')).not.toBeNull(); // at most two decimals
		expect(refused('R  5')).not.toBeNull();
		expect(refused('5 rand')).not.toBeNull();
		expect(refused('1e3')).not.toBeNull();
		expect(refused('12345678901234')).toMatch(/13 digits/);
	});
	it('formats through the shared fmtR as a 2-dp string', () => {
		expect(fmtR(centsText(cents('R 1 000.00')))).toBe('R 1 000.00');
		expect(fmtR(centsText(-12345n))).toBe('-R 123.45');
		expect(fmtR(centsText(5n))).toBe('R 0.05');
	});
});

describe('imported amounts and rounding', () => {
	it('reads the records.ts Amount shape exactly, empty as no value', () => {
		expect(importedUnits('1150.00')).toBe(11500000n);
		expect(importedUnits('-1.5')).toBe(-15000n);
		expect(importedUnits('')).toBeNull();
		expect(importedUnits('1 000')).toBeNull();
	});
	it('rounds a 4-decimal amount exact half-up, where toFixed(2) does not (1.005)', () => {
		expect((1.005).toFixed(2)).toBe('1.00');
		expect(centsText(unitsToCents(importedUnits('1.005')!))).toBe('1.01');
		expect(centsText(unitsToCents(importedUnits('1.0049')!))).toBe('1.00');
		expect(centsText(unitsToCents(importedUnits('-1.005')!))).toBe('-1.01');
		expect(centsText(unitsToCents(importedUnits('2.675')!))).toBe('2.68');
	});
	it('sums exactly; empty values count as zero like v5', () => {
		expect(sumImported(['0.1', '0.2', '', '0.3'])).toBe(6000n);
		expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
	});
	it('divides half away from zero', () => {
		expect(divRound(5n, 2n)).toBe(3n);
		expect(divRound(-5n, 2n)).toBe(-3n);
		expect(divRound(4n, 3n)).toBe(1n);
	});
	it('rounds doubles from their value', () => {
		expect(floatToCents(110493.89912)).toBe(11049390n);
		expect(floatToCents(-100000)).toBe(-10000000n);
		expect(floatToCents(Number.NaN)).toBeNull();
	});
	it('parses rates exactly', () => {
		const r = parseDecimal('10.5');
		expect(r.ok && [r.value.num, r.value.den, r.value.value]).toEqual([105n, 10n, 10.5]);
		expect(parseDecimal('').ok).toBe(false);
		expect(parseDecimal('-1').ok).toBe(false);
		expect(parseDecimal('1,5').ok).toBe(false);
		expect(parseDecimal('0').ok).toBe(true);
	});
});
