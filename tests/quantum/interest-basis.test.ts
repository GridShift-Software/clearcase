// GRS-173 (S-interest_calc_tab-5, S-payments_tab-3; IDR-245, IDR-246): the Interest Recalculator compares its total
// with the imported amount due only on one basis, as at the same date with no recorded payment in reach, and otherwise
// shows the amount due alone, says why, and names each figure's basis and payment treatment. Synthetic figures only.
import { describe, expect, it } from 'vitest';
import { importedUnits } from '../../src/lib/calculations/money';
import { interestOutcome, shownOutcome, unlikeBasis, type Due, type InterestInputs } from '../../src/lib/views/quantum/interest';

const I = (x: Partial<InterestInputs> = {}): InterestInputs => ({ p: '1000', r: '10', m: 'Simple', from: '2093-01-10', to: '2094-01-10', ...x });
const due = (x: Partial<Due> = {}): Due => ({ units: importedUnits('1150.00'), date: '2094-01-10', paymentDates: [], ...x });
const line = (i: InterestInputs, d: Due) => shownOutcome(i, d).kpis![3];
const PAID = 'needs a rule on whether a payment pays interest or capital first, which ClearCase does not apply';

describe('one basis: v5\'s comparison line', () => {
	it('as at the same date with no payment recorded, the line is interestOutcome\'s, and the verdict says why it compares', () => {
		const o = shownOutcome(I(), due());
		expect(o.kpis).toEqual(interestOutcome(I(), importedUnits('1150.00')).kpis);
		expect(o.kpis![3]).toEqual({ label: 'vs extracted Amount Due', value: 'R 1 150.00', sub: '-R 50.07 vs your calc' });
		expect(o.comparison!.verdict).toBe('Compared on one basis: both figures are as at 2094-01-10, and no payment is recorded on or before that date.');
	});
	it('a payment dated after the as-at date is outside both figures, so the line stays', () => {
		expect(unlikeBasis('2094-01-10', due({ paymentDates: ['2094-01-11'] }))).toEqual([]);
		expect(line(I(), due({ paymentDates: ['2094-01-11'] })).sub).toBe('-R 50.07 vs your calc');
	});
	it('an empty capital still asks for one, as in v5', () => {
		expect(line(I({ p: '' }), due()).sub).toBe('enter a capital figure');
	});
	it('names each figure\'s basis and payment treatment', () => {
		const c = shownOutcome(I({ m: 'Compound (monthly)' }), due()).comparison!;
		expect(c.total).toBe('Your total: the capital plus compound (monthly) interest from 2093-01-10 to 2094-01-10, on that one figure for the whole period. No payment is deducted.');
		expect(c.due).toBe('Extracted amount due: as at 2094-01-10, as the source statement gives it; ClearCase does not check what it includes. No recorded payment is deducted from it here; Payments & Net Claim deducts them for the net claim.');
	});
});

describe('unlike bases: the amount due alone, not compared', () => {
	it('a total as at another date', () => {
		const o = shownOutcome(I({ to: '2093-07-10' }), due());
		expect(o.kpis![3]).toEqual({ label: 'vs extracted Amount Due', value: 'R 1 150.00', sub: 'as at 2094-01-10: not comparable with your total' });
		expect(o.comparison!.verdict).toBe('Not compared, so no difference is shown: your total is as at 2093-07-10 and the amount due as at 2094-01-10.');
	});
	it('a recorded payment on or before the date, on it, or undated', () => {
		for (const d of ['2093-02-01', '2094-01-10', '', 'not a date', '0999-12-31']) {
			expect(line(I(), due({ paymentDates: [d] })).sub).toBe('as at 2094-01-10: not comparable with your total');
			expect(unlikeBasis('2094-01-10', due({ paymentDates: [d] }))).toEqual([`1 recorded payment is dated on or before 2094-01-10 or undated, and your total deducts none: netting it ${PAID}`]);
		}
	});
	it('counts only the payments in reach, and says them', () => {
		expect(unlikeBasis('2094-01-10', due({ paymentDates: ['2090-05-05', '', '2095-01-01'] }))).toEqual([`2 recorded payments are dated on or before 2094-01-10 or undated, and your total deducts none: netting them ${PAID}`]);
	});
	it('both reasons at once, in the verdict', () => {
		expect(shownOutcome(I({ to: '2093-07-10' }), due({ paymentDates: ['2093-02-01'] })).comparison!.verdict)
			.toBe(`Not compared, so no difference is shown: your total is as at 2093-07-10 and the amount due as at 2094-01-10; 1 recorded payment is dated on or before 2093-07-10 or undated, and your total deducts none: netting it ${PAID}.`);
	});
	it('no amount due in the package: nothing is compared against R 0.00', () => {
		const o = shownOutcome(I(), due({ units: null }));
		expect(o.kpis![3]).toEqual({ label: 'vs extracted Amount Due', value: '—', sub: 'not in this package' });
		expect(o.comparison).toEqual({ verdict: 'Not compared, so no difference is shown: this package gives no amount due.', total: expect.any(String), due: 'Extracted amount due: none in this package.' });
	});
	it('an amount due with no as-at date', () => {
		for (const date of ['', '2094-02-30']) {
			const o = shownOutcome(I(), due({ date }));
			expect(o.kpis![3]!.sub).toBe('with no as-at date: not comparable with your total');
			expect(o.comparison!.verdict).toBe('Not compared, so no difference is shown: the amount due has no as-at date.');
		}
	});
	it('the first three figures do not change', () => {
		expect(shownOutcome(I({ to: '2093-07-10' }), due({ paymentDates: [''] })).kpis!.slice(0, 3)).toEqual(interestOutcome(I({ to: '2093-07-10' }), importedUnits('1150.00')).kpis!.slice(0, 3));
	});
});

describe('no figures, no comparison', () => {
	it('an invalid or reversed input shows its error and no comparison', () => {
		for (const x of [{ to: '2092-01-10' }, { p: 'lots' }, { r: '' }]) {
			const o = shownOutcome(I(x), due({ paymentDates: [''] }));
			expect(o.kpis).toBeNull();
			expect(o.comparison).toBeNull();
			expect(Object.keys(o.errors).length).toBeGreaterThan(0);
		}
	});
});
