import { describe, expect, it } from 'vitest';
import { byCat, chipLabel, contradictionsCsv, rateCells, spreadLabel, type Contradictions } from './contradictions.ts';

const rateItem = { label: 'M1', detail: '', rates: { 'BID RATE': '10', 'OLD RATE': '12', 'NEW/STANDARD': '15' }, spread: '5', refs: [{ ref: 'OD-1', amount: '100', filename: 'f' }] };
const c: Contradictions = {
	total: 2, highCount: 1, byCat: { rate: 1 }, checks: [],
	categories: [
		{ key: 'rate', title: 'Rate title', severity: 'high', explain: 'x', items: [rateItem] },
		{ key: 'dupamt', title: 'Dup title', severity: 'low', explain: 'y', items: [{ label: 'INV-1', detail: 'Same, number', refs: [{ ref: 'OD-2', amount: '', filename: 'g' }, { ref: 'OD-3', amount: '7', filename: 'h' }] }] },
	],
};

describe('contradiction tracker', () => {
	it('formats a rate row as v5 does', () => {
		expect(rateCells(rateItem)).toEqual({ bid: 'R 10.00', old: 'R 12.00', next: 'R 15.00', spread: 'R 5.00' });
		expect(chipLabel(rateItem.refs[0]!)).toBe('OD-1 · R 100.00');
		expect(chipLabel({ ref: 'OD-2', amount: '', filename: '' })).toBe('OD-2');
		expect(chipLabel({ ref: 'OD-2', amount: 0, filename: '' })).toBe('OD-2');
		expect(chipLabel({ ref: 'OD-2', amount: '0', filename: '' })).toBe('OD-2 · R 0.00');
	});
	it("falls back to 'NEW RATE' and leaves absent rates empty", () => {
		expect(rateCells({ ...rateItem, rates: { 'NEW RATE': '9' }, spread: undefined })).toEqual({ bid: '', old: '', next: 'R 9.00', spread: '' });
	});
	it("shows an amount spread as v5's delta and a spelled-out spread as written", () => {
		expect(spreadLabel('1234.5')).toBe('Δ R 1 234.50');
		expect(spreadLabel('low R 1.00, high R 2.00, gap 50%')).toBe('low R 1.00, high R 2.00, gap 50%');
	});
	it('reads KPI figures by category key, 0 when absent', () => {
		expect([byCat(c, 'rate'), byCat(c, 'units'), byCat(c, 'constructor')]).toEqual([1, 0, 0]);
	});
	it("exports every item of every category in data order, refs joined by a space (v5's columns)", () => {
		expect(contradictionsCsv(c).split('\r\n')).toEqual(['category,severity,item,detail,spread,refs', 'Rate title,high,M1,,5,OD-1', 'Dup title,low,INV-1,"Same, number",,OD-2 OD-3']);
	});
	it('exports an item without refs with an empty refs cell instead of failing (S-contradictions_tab-2)', () => {
		const bare = { ...c, categories: [{ ...c.categories[1]!, items: [{ label: 'X', detail: '', refs: undefined as never }] }] };
		expect(contradictionsCsv(bare).split('\r\n')[1]).toBe('Dup title,low,X,,,');
	});
});
