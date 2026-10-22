// Settlement / BATNA form model (GRS-16): defaults only from the package (S-settlement_tab-1), the claim prefill net
// of recorded payments in whole rand (S-settlement_tab-2, -3), URL query inputs (BA-03), visible refusal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimPrefill, defaultInputs, settleInputs, settleOutcome, submitted } from '../../src/lib/views/quantum/settlement';

const D = { probability: 60, years: 3, discount: 8, cost: 1000 };

describe('defaults and prefill', () => {
	it('takes every default from the package and leaves a missing one empty', () => {
		expect(defaultInputs('1150', D)).toEqual({ claim: '1150', p: '60', y: '3', d: '8', c: '1000' });
		expect(defaultInputs('1150', { ...D, cost: null }).c).toBe('');
	});
	it('prefills the claim in whole rand, rounded half away from zero, as v5 toFixed(0)', () => {
		expect(claimPrefill(115050n)).toBe('1151');
		expect(claimPrefill(115049n)).toBe('1150');
		// a net below zero (payments above the claim) prefills a negative claim that the model computes (CC-06 r2, D10)
		expect(claimPrefill(-150n)).toBe('-2');
		const o = settleOutcome(defaultInputs(claimPrefill(-150n), D));
		expect([o.errors, o.kpis?.length]).toEqual([{}, 3]);
	});
	it('reads changed assumptions from the query over the defaults', () => {
		const def = defaultInputs('1000000', D);
		expect(submitted(new URLSearchParams(''))).toBe(false);
		expect(settleInputs(new URLSearchParams('p=95'), def)).toEqual({ ...def, p: '95' });
	});
});

describe('outcome', () => {
	const base = { claim: '1000000', p: '70', y: '2', d: '10', c: '100000' };
	it('shows clamped scenario probabilities and the undiscounted cost basis without changing the money', () => {
		const low = settleOutcome({ ...base, p: '10' });
		const high = settleOutcome({ ...base, p: '95' });
		expect(low.kpis![0]).toMatchObject({ label: 'Pessimistic (p=0%)', value: '-R 100 000.00', sub: 'Recovery probability 0%' });
		expect(high.kpis![2]).toMatchObject({ label: 'Optimistic (p=100%)', value: 'R 726 446.28', sub: 'Recovery probability 100%' });
		expect(low.floor).toContain('R 100 000.00 undiscounted enforcement costs');
		expect(high.floor).toContain('R 100 000.00 undiscounted enforcement costs');
	});
	it('the checklist example, with v5\'s labels', () => {
		const o = settleOutcome(base);
		expect(o.kpis!.map((k) => `${k.label}=${k.value}`)).toEqual(['Pessimistic (p-25)=R 271 900.83', 'Base (p=70%)=R 478 512.40', 'Optimistic (p+15)=R 602 479.34']);
		expect(o.floor).toContain('claim R 1 000 000.00 discounted for a 70% recovery probability over 2 year(s) at 10%, net of R 100 000.00 costs');
	});
	it('changing an assumption changes the result (scenario 8)', () => {
		expect(settleOutcome({ ...base, p: '95' }).kpis![2]!.value).toBe('R 726 446.28');
		expect(settleOutcome({ ...base, p: '10' }).kpis![0]!.value).toBe('-R 100 000.00');
	});
	it('parses a claim typed with separators in full', () => {
		expect(settleOutcome({ ...base, claim: 'R 1 000 000' }).kpis![1]!.value).toBe('R 478 512.40');
	});
	it('refuses text, negatives and empty fields visibly', () => {
		const o = settleOutcome({ claim: 'lots', p: '-5', y: '', d: '1,5', c: '' });
		expect(o.kpis).toBeNull();
		expect(Object.keys(o.errors).sort()).toEqual(['c', 'claim', 'd', 'p', 'y']);
	});
});

describe('cost basis wording and the S-settlement_tab-4 disposition (GRS-185 fix round)', () => {
	const repo = join(import.meta.dirname, '..', '..');
	it('names the cost as undiscounted in its error prefix', () => {
		const o = settleOutcome({ claim: '1000000', p: '70', y: '2', d: '10', c: 'abc' });
		expect(o.errors.c).toMatch(/^Enforcement cost \(undiscounted\): /);
	});
	it('names the cost as undiscounted in the missing-default note', () => {
		const page = readFileSync(join(repo, 'src/routes/v/[vid]/quantum/settlement_tab/+page.svelte'), 'utf8');
		expect(page).toContain("['cost', 'Enforcement cost (undiscounted)']");
		expect(page).not.toContain("'Enforcement cost']");
	});
	it('registers the defect as a known gap with an owner: the undiscounted cost remains', () => {
		const doc = JSON.parse(readFileSync(join(repo, 'docs/reference/parity/register/CC-06.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
		const e = doc.entries.find((x) => x.source === 'S-settlement_tab-4' && Array.isArray(x.field) && x.field.length === 0)!;
		expect(e).toMatchObject({ type: 'known-gap', approvedBy: null, approvedOn: null });
		expect(e.owner).toBeTruthy();
		expect(String(e.reason)).toMatch(/undiscounted/);
		expect(String(e.reason)).toMatch(/model decision/);
		expect(String(e.reason)).toContain('IDR-453');
		expect(String(e.reason)).not.toMatch(/shows each actual recovery probability/);
	});
});
