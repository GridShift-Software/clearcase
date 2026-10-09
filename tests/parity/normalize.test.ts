// Normalization is explicit: each rule has a case here, and anything outside the rules compares exactly.
import { describe, expect, test } from 'vitest';
import { canonicalTies, controlId, date, inventory, number, slug, value, ws } from '../../scripts/parity/lib/normalize.mjs';

describe('white space', () => {
	test('collapses runs, trims, and treats NBSP, thin and narrow spaces as spaces', () => {
		expect(ws('  a \n\t b  ')).toBe('a b');
		expect(ws('R 1 234')).toBe('R 1 234');
		expect(ws(null)).toBe('');
		expect(ws(undefined)).toBe('');
	});
	test('composes to NFC, so a decomposed accent equals the composed one', () => {
		expect(ws('é')).toBe('é');
	});
});

describe('numbers and money', () => {
	test('digit grouping with commas, spaces or none is the same number', () => {
		for (const s of ['1,689', '1 689', '1689', ' 1,689 ']) expect(number(s)).toBe('1689');
		expect(number('-12,345.50')).toBe('-12345.50');
	});
	test('v5 fmtR money and its spellings normalize to one form; the sign leads', () => {
		expect(number('R 1 234 567.50')).toBe('R1234567.50');
		expect(number('R1,234,567.50')).toBe('R1234567.50');
		expect(number('-R 5.00')).toBe('-R5.00');
		expect(number('R -5.00')).toBe('-R5.00');
	});
	test('shown precision is kept: 2.5 and 2.50 differ', () => {
		expect(number('2.5')).not.toBe(number('2.50'));
	});
	test('text that is not a number is unchanged', () => {
		for (const s of ['0.0 h', 'SY-0001', '12 high-severity', '1,68', 'R 12 34']) expect(number(s)).toBe(ws(s));
	});
});

describe('dates', () => {
	test('ISO dates and date-times stay as they are', () => {
		expect(date('2030-01-31')).toBe('2030-01-31');
		expect(date('2030-01-31 09:00')).toBe('2030-01-31 09:00');
	});
	test('day month year spellings become ISO', () => {
		expect(date('8 Oct 2026')).toBe('2026-10-08');
		expect(date('08 October 2026')).toBe('2026-10-08');
		expect(date('8 Sept. 2026')).toBe('2026-09-08');
	});
	test('ambiguous numeric dates are not guessed', () => {
		expect(date('01/02/2026')).toBe('01/02/2026');
	});
	test('empty-date markers are not normalized away: a changed marker is a difference', () => {
		expect(value('—')).not.toBe(value('undated'));
		expect(value('—')).not.toBe(value(''));
	});
});

describe('sort stability', () => {
	test('canonicalTies orders keys only within runs of equal sort values', () => {
		expect(canonicalTies(['c', 'a', 'b', 'e', 'd'], ['', '', '2020', '2021', '2021'])).toEqual(['a', 'c', 'b', 'd', 'e']);
	});
	test('a different order across sort values is still visible', () => {
		expect(canonicalTies(['b', 'a'], ['2021', '2020'])).toEqual(['b', 'a']);
	});
});

describe('control inventory', () => {
	test('counts and sort indicators in labels do not change a control identity', () => {
		expect(controlId('button', 'Export CSV (1,689 rows)')).toBe('button:Export CSV (# rows)');
		expect(controlId('button', 'Export CSV (12 rows)')).toBe('button:Export CSV (# rows)');
		expect(controlId('sort-header', 'Date ▲')).toBe('sort-header:Date');
		expect(controlId('sort-header', 'Date ▼')).toBe('sort-header:Date');
	});
	test('the inventory keeps multiplicity', () => {
		expect(inventory([{ kind: 'link', label: 'open' }, { kind: 'link', label: 'open' }, { kind: 'button', label: 'Add' }])).toEqual({ 'link:open': 2, 'button:Add': 1 });
	});
	test('slugs are stable ids', () => {
		expect(slug('Amount due (to date)')).toBe('amount_due_to_date');
		expect(slug('Scanned (need OCR)')).toBe('scanned_need_ocr');
		expect(slug('')).toBe('_');
	});
});
