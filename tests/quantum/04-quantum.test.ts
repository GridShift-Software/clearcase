// Ticket 04: Payments & Net Claim, the Interest Recalculator and Settlement split into a pure part (the version alone)
// and a merge part (the payments register). merge(pure, no payments) equals load, and load with payments is what it
// was before the split. Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCase, type Booted, type J } from '../registers/04-harness';

let b: Booted;
const routes: Record<string, unknown> = {};
beforeAll(async () => {
	b = await bootCase('04-quantum');
	routes.payments = await import('../../src/routes/v/[vid]/quantum/payments_tab/+page.server');
	routes.interest = await import('../../src/routes/v/[vid]/quantum/interest_calc_tab/+page.server');
	routes.settlement = await import('../../src/routes/v/[vid]/quantum/settlement_tab/+page.server');
}, 180_000);
afterAll(() => b?.stop());

const split = async () => {
	const data = await import('../../src/lib/views/quantum/data.server');
	return {
		payments: { pure: data.paymentsPure, merge: (await import('../../src/lib/views/quantum/payments')).paymentsMerge },
		interest: { pure: data.interestPure, merge: (await import('../../src/lib/views/quantum/interest')).interestMerge },
		settlement: { pure: data.settlementPure, merge: (await import('../../src/lib/views/quantum/settlement')).settlementMerge },
	};
};
const payments = async () => (await import('../../src/lib/views/quantum/writes.server')).listPayments(b.lc.userWork, b.caseId);

describe('quantum: pure and merge', () => {
	it('merge(pure, no payments) equals load for all three views', async () => {
		const s = await split();
		const empty = { payments: [] };
		expect(s.payments.merge(s.payments.pure(b.input()), empty)).toEqual(await b.load(routes.payments));
		expect(s.interest.merge(s.interest.pure(b.input()), empty)).toEqual(await b.load(routes.interest));
		expect(s.settlement.merge(s.settlement.pure(b.input()), empty)).toEqual(await b.load(routes.settlement));
	});

	it('the shards hold no payment', async () => {
		const s = await split();
		expect(Object.keys(s.payments.pure(b.input())).sort()).toEqual(['claim', 'claimDate', 'exportName', 'known', 'recon', 'subtitle']);
		expect(Object.keys(s.interest.pure(b.input())).sort()).toEqual(['defaults', 'headlineDate', 'headlineDue', 'known', 'note']);
		expect(Object.keys(s.settlement.pure(b.input())).sort()).toEqual(['claimDate', 'defaults', 'importedClaim', 'narrative', 'subtitle']);
	});

	it('with payments, load shows them, their dates and the net claim as before', async () => {
		const { addPayment } = await import('../../src/lib/views/quantum/writes.server');
		await addPayment(b.lc.userWork, b.caseId, { date: '2001-05-01', amount: '100.00', method: 'EFT', note: 'Invented' }, 10000n);
		await addPayment(b.lc.userWork, b.caseId, { date: '2001-06-01', amount: 'unclear', method: '', note: '' }, 0n);
		const p = await b.load(routes.payments);
		expect(p.payments.map((x: J) => [x.date, x.amount, x.amountCents, typeof x.hash])).toEqual([['2001-05-01', '100.00', '10000', 'string'], ['2001-06-01', 'unclear', '0', 'string']]);
		const i = await b.load(routes.interest);
		expect(i.paymentDates).toEqual(['2001-05-01', '2001-06-01']);
		const st = await b.load(routes.settlement);
		expect(st.claim).toBe('1050');
		expect(st.payments).toEqual({ count: 2, counted: 2, gross: '115000', paid: '10000', excess: null, claimDate: '2001-03-04' });
		const s = await split();
		const w = { payments: await payments() };
		expect(s.payments.merge(s.payments.pure(b.input()), w)).toEqual(p);
		expect(s.interest.merge(s.interest.pure(b.input()), w)).toEqual(i);
		expect(s.settlement.merge(s.settlement.pure(b.input()), w)).toEqual(st);
	});
});
