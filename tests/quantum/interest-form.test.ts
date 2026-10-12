// Interest Recalculator form model (GRS-16): query inputs and defaults (BA-03), visible refusal of invalid and
// reversed inputs (S-interest_calc_tab-1, -3), the default rate from the package only (S-interest_calc_tab-2).
import { describe, expect, it } from 'vitest';
import { importedUnits } from '../../src/lib/calculations/money';
import { defaultInputs, interestOutcome, queryInputs } from '../../src/lib/views/quantum/interest';

const D = { rate: 7.25, from: '2081-01-31', to: '2082-01-31' };
const q = (s: string) => new URLSearchParams(s);
const head = importedUnits('1150.00');

describe('inputs', () => {
	it('shows the defaults without a query; the rate is the package\'s, never a literal', () => {
		expect(queryInputs(q(''), D)).toBeNull();
		expect(defaultInputs(D)).toEqual({ p: '', r: '7.25', m: 'Simple', from: '2081-01-31', to: '2082-01-31' });
		expect(defaultInputs({ ...D, rate: null }).r).toBe('');
	});
	it('reads a submitted calculation from the query, so a reload gives the same result', () => {
		const i = queryInputs(q('p=100000&r=10&m=Simple&from=2004-02-03&to=2005-02-03'), D)!;
		expect(i).toEqual({ p: '100000', r: '10', m: 'Simple', from: '2004-02-03', to: '2005-02-03' });
		expect(interestOutcome(i, head)).toEqual(interestOutcome(queryInputs(q(new URLSearchParams(i as never).toString()), D)!, head));
	});
});

describe('outcome', () => {
	it('interest-simple with the comparison line', () => {
		const o = interestOutcome({ p: '100000', r: '10', m: 'Simple', from: '2004-02-03', to: '2005-02-03' }, head);
		expect(o.kpis!.map((k) => [k.label, k.value, k.sub])).toEqual([
			['Capital', 'R 100 000.00', ''], ['Interest (1.00 yrs)', 'R 10 020.53', ''], ['Total', 'R 110 020.53', ''], ['vs extracted Amount Due', 'R 1 150.00', '+R 108 870.53 vs your calc'],
		]);
	});
	it('an empty capital is zero, as in v5', () => {
		const o = interestOutcome({ ...defaultInputs(D) }, head);
		expect(o.kpis![0]!.value).toBe('R 0.00');
		expect(o.kpis![3]!.sub).toBe('enter a capital figure');
	});
	it('parses a capital typed with separators in full (S-interest_calc_tab-1)', () => {
		expect(interestOutcome({ p: 'R 100 000.00', r: '10', m: 'Compound (monthly)', from: '2004-02-03', to: '2005-02-03' }, head).kpis![2]!.value).toBe('R 110 493.90');
	});
	it('refuses a reversed period visibly and computes nothing (S-interest_calc_tab-3)', () => {
		const o = interestOutcome({ p: '100000', r: '10', m: 'Simple', from: '2005-02-03', to: '2004-02-03' }, head);
		expect(o.kpis).toBeNull();
		expect(o.errors.to).toMatch(/reversed/);
	});
	it('refuses invalid dates, a missing rate, text in the capital and an unknown method', () => {
		const o = interestOutcome({ p: 'lots', r: '', m: 'Daily', from: '2081-02-29', to: '' }, head);
		expect(o.kpis).toBeNull();
		expect(Object.keys(o.errors).sort()).toEqual(['from', 'm', 'p', 'r', 'to']);
	});
	it('a zero-day period gives zero interest and v5\'s 0 yrs label', () => {
		const o = interestOutcome({ p: '1000', r: '10', m: 'Simple', from: '2081-01-31', to: '2081-01-31' }, head);
		expect(o.kpis![1]).toEqual({ label: 'Interest (0 yrs)', value: 'R 0.00', sub: '' });
	});
});
