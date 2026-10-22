// Every CSV writer in src/ (GRS-172): imported text that starts a formula reaches the file only after a `'`, while a
// plain number and a validated signed-money amount stay numbers. The chronology page builds its rows inline and hands
// them to toCSV, so csv.test.ts covers it through csvCell.
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../scripts/parity/lib/exports.mjs';
import type { ChronologyListRow } from '../local-case/model.ts';
import { contradictionsCsv } from '../views/analysis/contradictions.ts';
import { defenceCsv } from '../views/analysis/defence.ts';
import { contractsCsvRows } from '../views/evidence/contracts.ts';
import { filingsCsvRows, registerCsvRows } from '../views/evidence/filings.ts';
import { exportRows } from '../views/evidence/search.ts';
import { authoritiesCsv } from '../views/litigation/authorities.ts';
import { invoicesCsv } from '../views/quantum/ledger.ts';
import { paymentsCsv } from '../views/quantum/payments.ts';
import { prescriptionCsv } from '../views/quantum/prescription.ts';
import { REGISTERS } from '../views/registers/defs.ts';
import { registerCsv } from '../views/registers/logic.ts';
import { toCSV } from './csv.ts';

const chronologyRow = (h: string, amount: string): ChronologyListRow & { cc: string } => ({
	ref: h, ord: 1, date: h, dateType: null, dateSource: null, docType: h, bundle: h, subject: h, filename: h, sender: h, to: h,
	excerpt: h, amount, alsoIn: [h], url: h, textStatus: h, parentRef: null, file: 'present', preview: 'none', attachments: 0, cc: h,
});
const filing = (h: string) => ({ filing: h, fdate: h, fparty: h, response: h, rdate: h, ref: h, status: h });

/** Each writer with every text field set to `h`, and its signed number, if it has one, set to a credit. */
const WRITERS: [string, (h: string) => string, string | null][] = [
	['search export (evidence/search/export/+server.ts)', (h) => toCSV(exportRows([chronologyRow(h, '-500.00')])), '-500.00'],
	['filings groups (filings_tab)', (h) => toCSV(filingsCsvRows([{ key: h, note: h, items: [{ ref: h, date: h, title: h, note: h, doc_type: h, text_status: h, url: h }] }])), null],
	['filings register, imported seed (filings_tab)', (h) => toCSV(registerCsvRows([{ key: 'k', state: 'seed', fields: filing(h), imported: filing(h), userEntered: false, deletedEarlier: false, seedSha256: null, seed: filing(h) }])), null],
	['contracts (contracts_tab)', (h) => toCSV(contractsCsvRows([{ key: h, items: [{ ref: h, date: h, title: h, note: h, text_status: h, url: h }] }])), null],
	['contradictions (contradictions_tab)', (h) => contradictionsCsv({ total: 1, highCount: 0, byCat: {}, checks: [], categories: [{ key: 'k', title: h, severity: h, explain: h, items: [{ label: h, detail: h, spread: '-12.50', refs: [{ ref: h, amount: '', filename: h }] }] }] }), '-12.50'],
	['defence (vdm_matrix_tab)', (h) => defenceCsv(['a', 'b', 'c', 'd', 'e'], [{ point: h, dcs: h, evidence: h, rebuttal: h, refs: h, docs: [{ ref: h }] }], true), null],
	['authorities, imported (authorities_tab)', (h) => authoritiesCsv([{ topic: h, authority: h, proposition: h }], []), null],
	['invoices (invoice_ledger_tab, quantum_tab)', (h) => invoicesCsv([{ amount: '-500.00', bundle: h, date: h, no: h, ref: h, text_status: h, url: h }]), '-500.00'],
	['prescription (prescription_tab)', (h) => prescriptionCsv([{ no: h, ref: h, date: h, prescDate: h, risk: h, url: h }]), null],
	['payments, typed (payments_tab)', (h) => paymentsCsv([{ rowId: 'r', seq: 1, date: h, amount: h, amountCents: null, method: h, note: h }]), null],
	['disbursements register, typed (RegisterPage)', (h) => registerCsv(REGISTERS.disbursements_tab, [{ rowId: 'r', values: { date: h, desc: h, payee: h, amount: '-500' } }]), '-500.00'],
];

describe('every CSV writer neutralises a formula start (GRS-172)', () => {
	describe.each(WRITERS)('%s', (_, write, credit) => {
		it.each(['=', '+', '-', '@', '\t', '\r'])('%j', (lead) => {
			const h = `${lead}SYN(1)`;
			const cells = parseCsv(write(h)).slice(1).flat();
			expect(cells).toContain(`'${h}`);
			expect(cells.filter((c) => /^[=+\-@\t\r]/.test(c) && c !== credit)).toEqual([]);
			if (credit) expect(cells).toContain(credit);
		});
	});
});
