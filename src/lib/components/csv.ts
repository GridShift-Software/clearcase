// CSV export shared by views (v5 toCSV, with S-_shell-6 fixed for quoting): a cell is quoted when it contains a quote,
// comma, semicolon, tab, CR or LF; quotes are doubled; rows end with CRLF. Quoting `;` and tab keeps a cell whole in a
// spreadsheet that splits on them (the `;` separator is the default in many locales), so text after one cannot start a
// cell of its own and run as a formula. Imported values are exported unchanged. User-entered cells must pass through
// GRS-10 exportCell first (formula neutralisation of a leading character), which `userCell` marks explicitly.
import { exportCell } from '../case-package/browser.ts';

export type Cell = string | number | null | undefined | readonly string[];
const text = (c: Cell) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c));
export const csvCell = (c: Cell) => { const s = text(c); return /[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export const toCSV = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
/** A cell the user typed: neutralised against spreadsheet formulas. */
export const userCell = (s: string) => exportCell(s);

/** Offer text as a file download in the browser (no server round trip, no network). */
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
