import { exportCell } from '../case-package/browser.ts';

export type Cell = string | number | null | undefined | readonly string[];
const text = (c: Cell) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c));
const SEGMENT = /([;\t\r\n] *)(?=["=+\-@\t\r])/g;
const atSegments = (s: string) => s.replace(SEGMENT, "$1'");
export const csvCell = (c: Cell) => { const s = atSegments(text(c)); return /[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export const toCSV = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
export const userCell = (v: string | readonly string[]) => atSegments(exportCell(typeof v === 'string' ? v : v.join('; ')));
// imported here, not above: the parity register cites the lines above by number (register-dispositions.mjs)
import { centsText } from '../calculations/money.ts';
import { parseAmount } from '../views/registers/amounts.ts';
/** A signed-money amount the parser accepts, as a plain number (-500.00) a spreadsheet sums; anything else as userCell. */
export function monetaryCell(raw: string): string {
	const amount = parseAmount(raw, 'signed-money');
	return amount.kind === 'ok' ? centsText(amount.units) : userCell(raw);
}

export function download(name: string, content: string, type = 'text/csv;charset=utf-8') {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
