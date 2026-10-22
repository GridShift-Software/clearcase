// Quantum & Interest and Invoice Ledger model (GRS-16): the invoice export, the exact ledger sum, the reconciliation
// flags (imported figures shown unchanged, a mismatch flagged) and the amount-due chart. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { chart, importedMoney, invoicesCsv, ledgerSum, reconcile, statusText, unitsMoney, type LedgerRow } from '../../src/lib/views/quantum/ledger';

const row = (ref: string, amount: string, o: Partial<LedgerRow> = {}): LedgerRow => ({ ref, amount, bundle: 'Original', date: '2081-01-31', no: `SYN${ref.slice(-3)}`, text_status: 'extracted', url: `./x/${ref}.pdf`, ...o });

describe('invoice ledger', () => {
	it('sums the ledger exactly; an empty amount counts as zero (v5 parseFloat||0)', () => {
		const rows = [row('OD-901', '0.10'), row('OD-902', '0.20'), row('OD-903', ''), row('OD-904', '1000000.005')];
		expect(unitsMoney(ledgerSum(rows))).toBe('R 1 000 000.31');
	});
	it('exports every row in data order with v5\'s columns and the source values unchanged', () => {
		const csv = invoicesCsv([row('OD-902', '5.00', { date: '' }), row('OD-901', '1,5'.replace(',', ''))]).split('\r\n');
		expect(csv[0]).toBe('ref,no,date,amount,bundle,text_status,url');
		expect(csv[1]).toBe('OD-902,SYN902,,5.00,Original,extracted,./x/OD-902.pdf');
		expect(csv).toHaveLength(3);
	});
	it('goes through the base CSV encoder: an imported cell is neutralised where a formula starts a segment after ; or a line break', () => {
		const csv = invoicesCsv([row('OD-902', '5.00', { text_status: 'ok;=1+1', bundle: 'a\r\n=2+2' })]).split('\r\n').join('|');
		expect(csv).toContain('"ok;\'=1+1"');
		expect(csv).not.toMatch(/[;|]=/);
	});
	it('shows imported amounts rounded exact half-up; empty stays empty', () => {
		expect(importedMoney('2.675')).toBe('R 2.68');
		expect(importedMoney('')).toBe('');
		expect(importedMoney('-5')).toBe('-R 5.00');
	});
	it('words the text status as v5\'s badge', () => {
		expect(['extracted', 'ocr', 'none', 'pending', '', 'other'].map(statusText)).toEqual(['extracted', 'ocr', 'scan · none', 'pending', '—', 'other']);
	});
});

describe('reconciliation with the imported reference figures', () => {
	const rows = [row('OD-901', '100.00'), row('OD-902', '50.50')];
	it('agrees when the imported count and gross equal the ledger', () => {
		expect(reconcile({ invoiceCount: 2, grossInvoiced: '150.50', invoiceLedger: rows })).toMatchObject({ countMatches: true, sumMatches: true });
	});
	it('flags a different imported gross or count, keeping the imported values', () => {
		const r = reconcile({ invoiceCount: 3, grossInvoiced: '150.00', invoiceLedger: rows });
		expect(r).toMatchObject({ countMatches: false, sumMatches: false, ledgerLength: 2 });
		expect(unitsMoney(r.ledgerSum)).toBe('R 150.50');
		expect(unitsMoney(r.imported!)).toBe('R 150.00');
	});
});

describe('amount-due chart', () => {
	it('fits a dense series inside the plot without overlapping bars', () => {
		const rows = Array.from({ length: 1000 }, (_, i) => ({ date: `2081-01-${String(i + 1).padStart(4, '0')}`, ref: `SD-${i}`, amount: '100.00' }));
		const c = chart(rows)!;
		const right = c.width - 8;
		for (let i = 0; i < c.bars.length; i++) {
			const bar = c.bars[i]!;
			const start = Number(bar.x);
			const end = start + Number(bar.w);
			expect(Number(bar.w)).toBeGreaterThan(0);
			expect(start).toBeGreaterThanOrEqual(8);
			expect(end).toBeLessThanOrEqual(right);
			if (i + 1 < c.bars.length) expect(end).toBeLessThanOrEqual(Number(c.bars[i + 1]!.x));
		}
	});
	it('scales bars to the peak and captions first, last and peak (v5 quantumChart)', () => {
		const c = chart([{ date: '2081-01-31', ref: 'SD-901', amount: '50.00' }, { date: '2081-02-28', ref: 'SD-902', amount: '200.00' }])!;
		expect(c.caption).toBe('2081-01-31 → 2081-02-28 · peak R 200.00');
		expect(c.bars[1]!.h).toBe('144.0');
		expect(c.bars[0]!.h).toBe('36.0');
		expect(c.bars[0]!.w).toBe('370.0');
	});
	it('draws no negative bar and nothing for an empty series', () => {
		const c = chart([{ date: '2081-01-31', ref: 'SD-901', amount: '-5.00' }, { date: '2081-02-28', ref: 'SD-902', amount: '10.00' }])!;
		expect(c.bars[0]!.h).toBe('0.0');
		expect(chart([])).toBeNull();
	});
});
