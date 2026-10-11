// Payments & Net Claim model (GRS-16): one parse for the table and the totals (S-payments_tab-1), insertion order by
// seq under a fixed clock, legacy rows flagged and never coerced, and the export.
import { describe, expect, it } from 'vitest';
import { fmtR } from '../../src/lib/components/format';
import { centsText, importedUnits, parseAmount } from '../../src/lib/calculations/money';
import { nextSeq, ordered, paymentFields, paymentOf, paymentsCsv, totals, type Payment } from '../../src/lib/views/quantum/payments';

const R = (c: bigint) => fmtR(centsText(c));
const pay = (rowId: string, amount: string, seq: number, extra: Partial<Payment> = {}): Payment => {
	const p = parseAmount(amount);
	return paymentOf(rowId, { ...paymentFields({ date: '', amount, method: '', note: '' }, p.ok ? p.value : 0n, seq), ...(p.ok ? {} : { amountCents: null }), ...extra } as never);
};

describe('net claim', () => {
	it('the checklist example: claim 1000.00, payments 100 and 250.50', () => {
		const t = totals(importedUnits('1000.00')!, [pay('a', '100', 1), pay('b', '250.50', 2)]);
		expect([R(t.gross), R(t.paid), t.receipts, R(t.net)]).toEqual(['R 1 000.00', 'R 350.50', 2, 'R 649.50']);
	});
	it('no payments: the net claim is the gross claim', () => {
		const t = totals(importedUnits('1150.00')!, []);
		expect([R(t.paid), t.receipts, R(t.net)]).toEqual(['R 0.00', 0, 'R 1 150.00']);
	});
	it('subtracts the same parsed cents the table shows (S-payments_tab-1): 1 000 and R 500 count in full', () => {
		const rows = [pay('a', '1 000', 1), pay('b', 'R 500', 2), pay('c', '1,000.25', 3)];
		expect(rows.map((r) => R(r.amountCents!))).toEqual(['R 1 000.00', 'R 500.00', 'R 1 000.25']);
		expect(R(totals(importedUnits('5000.00')!, rows).net)).toBe('R 2 499.75');
	});
	it('rounds the imported claim once, exact half-up', () => {
		expect(R(totals(importedUnits('1000.005')!, [pay('a', '0.01', 1)]).net)).toBe('R 1 000.00');
		expect(R(totals(importedUnits('1000.005')!, []).gross)).toBe('R 1 000.01');
	});
	it('flags a stored row whose amount never parsed and does not count it', () => {
		const legacy = paymentOf('x', { date: '', amount: 'Synthetic entry 1', amountCents: null, method: '', note: '', seq: 1 });
		const t = totals(importedUnits('100.00')!, [legacy, pay('y', '10', 2)]);
		expect([legacy.amountCents, t.receipts, t.uncounted, R(t.paid), R(t.net)]).toEqual([null, 2, 1, 'R 10.00', 'R 90.00']);
	});
});

describe('order and storage fields', () => {
	it('orders by seq whatever the row ids (a fixed clock gives every row the same createdAt)', () => {
		const rows = [pay('ffff', '3', 3), pay('0000', '1', 1), pay('8888', '2', 2)];
		expect(ordered(rows).map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(nextSeq(rows)).toBe(4);
		expect(nextSeq([])).toBe(1);
	});
	it('stores the typed text and the parsed cents', () => {
		expect(paymentFields({ date: '2026-01-02', amount: 'R 1 000.00', method: 'EFT', note: 'n' }, 100000n, 7)).toEqual({ date: '2026-01-02', amount: 'R 1 000.00', amountCents: 100000, method: 'EFT', note: 'n', seq: 7 });
	});
	it('never trusts a stored amountCents that is not a safe integer', () => {
		expect(paymentOf('r', { amount: '1', amountCents: 1.5, seq: 1 }).amountCents).toBeNull();
	});
});

describe('export', () => {
	it('writes v5\'s columns in insertion order, the typed text neutralised against formulas', () => {
		const csv = paymentsCsv([pay('b', '20', 2, { note: '=HYPERLINK("x")' }), pay('a', 'R 1 000.00', 1, { method: 'EFT, ref 1' })]);
		const lines = csv.split('\r\n');
		expect(lines[0]).toBe('date,amount,method,note');
		expect(lines[1]).toBe(',R 1 000.00,"EFT, ref 1",');
		expect(lines[2]!.startsWith(',20,,')).toBe(true);
		expect(lines[2]).not.toMatch(/,=HYPERLINK/);
	});
	it('keeps a formula after `;` or tab inert for a reader that splits on them (D16, BASE-R2c)', () => {
		const csv = paymentsCsv([pay('a', '1', 1, { method: 'x\t=1+1', note: 'x;=1+1' })]);
		expect(csv.split('\r\n')[1]).toBe(`,1,"x\t'=1+1","x;'=1+1"`);
		for (const seg of csv.split(/[,;\t\r\n]/)) expect(seg).not.toMatch(/^ *"?[=+\-@]/);
	});
});
