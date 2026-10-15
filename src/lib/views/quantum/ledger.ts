import { toCSV } from '../../components/csv.ts';
import { fmtR } from '../../components/format.ts';
import { centsText, importedUnits, sumImported, unitsToCents } from '../../calculations/money.ts';

export interface LedgerRow { amount: string; bundle: string; date: string; no: string; ref: string; text_status: string; url: string }
export interface SeriesRow { amount: string; date: string; ref: string }

export function importedMoney(s: string | null | undefined): string {
	const u = importedUnits(s);
	return u === null ? '' : fmtR(centsText(unitsToCents(u)));
}
/** Ten-thousandths for display. */
export const unitsMoney = (u: bigint) => fmtR(centsText(unitsToCents(u)));

export const INVOICE_COLUMNS = ['ref', 'no', 'date', 'amount', 'bundle', 'text_status', 'url'] as const;
export const invoicesCsv = (rows: readonly LedgerRow[]) => toCSV([[...INVOICE_COLUMNS], ...rows.map((r) => INVOICE_COLUMNS.map((k) => r[k]))]);

export const ledgerSum = (rows: readonly LedgerRow[]) => sumImported(rows.map((r) => r.amount));

export const statusText = (t: string) => ({ extracted: 'extracted', ocr: 'ocr', none: 'scan · none', pending: 'pending' } as Record<string, string>)[t] ?? (t || '—');

export interface Reconciliation { countMatches: boolean; ledgerLength: number; sumMatches: boolean; ledgerSum: bigint; imported: bigint | null }
export function reconcile(q: { invoiceCount: number; grossInvoiced: string; invoiceLedger: readonly LedgerRow[] }): Reconciliation {
	const sum = ledgerSum(q.invoiceLedger);
	const imported = importedUnits(q.grossInvoiced);
	return { countMatches: q.invoiceCount === q.invoiceLedger.length, ledgerLength: q.invoiceLedger.length, sumMatches: imported === sum, ledgerSum: sum, imported };
}

export interface Bar { x: string; y: string; w: string; h: string; title: string }
export interface Chart { width: number; height: number; bars: Bar[]; caption: string }

export function chart(series: readonly SeriesRow[]): Chart | null {
	if (!series.length) return null;
	const W = 760, H = 160, pad = 8, n = series.length;
	const units = series.map((s) => importedUnits(s.amount) ?? 0n);
	const max = units.reduce((m, u) => (u > m ? u : m), units[0]!);
	const maxN = Number(max);
	const bw = Math.max(2, (W - 2 * pad) / n - 2);
	const bars = series.map((s, i) => {
		const v = Number(units[i]!);
		const bh = maxN > 0 ? Math.max(0, (v / maxN) * (H - 2 * pad)) : 0;
		const x = pad + i * ((W - 2 * pad) / n);
		return { x: x.toFixed(1), y: (H - pad - bh).toFixed(1), w: bw.toFixed(1), h: bh.toFixed(1), title: `${s.date}: ${importedMoney(s.amount)}` };
	});
	return { width: W, height: H, bars, caption: `${series[0]!.date} → ${series[n - 1]!.date} · peak ${unitsMoney(max)}` };
}
