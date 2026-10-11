// CSV export shared by views (v5 toCSV, with S-_shell-6 fixed for quoting): a cell is quoted when it contains a quote,
// comma, semicolon, tab, CR or LF; quotes are doubled; rows end with CRLF. Quoting `;` and tab keeps a cell whole in a
// spreadsheet that splits on them (the `;` separator is the default in many locales), but only when the cell's opening
// quote also starts a field there: in a later column (`T,A,"x;=1+1"`) a `;`-splitting reader sees `T,A,"x` and then
// `=1+1"`, and a CR or LF starts a new row the same way. So `userCell` neutralises (prefixes `'`) a formula character
// (=, +, -, @, tab or CR) that starts the cell or, after any leading spaces, a segment after `;`, tab, CR or LF; GRS-10
// exportCell does the first. Imported values are exported unchanged; exportCell keeps its leading-character rule.
import { exportCell } from '../case-package/browser.ts';

export type Cell = string | number | null | undefined | readonly string[];
const text = (c: Cell) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c));
export const csvCell = (c: Cell) => { const s = text(c); return /[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export const toCSV = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
/** A cell the user typed: neutralised against spreadsheet formulas at its start and at every `;`, tab, CR or LF segment. */
export const userCell = (s: string) => exportCell(s).replace(/([;\t\r\n] *)(?=[=+\-@\t\r])/g, "$1'");

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
