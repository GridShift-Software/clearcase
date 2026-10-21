import { exportCell } from '../case-package/browser.ts';

export type Cell = string | number | null | undefined | readonly string[];
const text = (c: Cell) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c));
const SEGMENT = /([;\t\r\n] *)(?=["=+\-@\t\r])/g;
const atSegments = (s: string) => s.replace(SEGMENT, "$1'");
/** The one rule for every exported text cell, imported or typed: a `'` before a formula start and before each segment after a separator. */
const neutral = (s: string) => atSegments(exportCell(s));
// The two exceptions, cells that keep their sign so a spreadsheet reads a number: a plain decimal number in any cell
// (PLAIN_NUMBER: -5 and -500.00, not -1+2, -1e3 or +27 82 000 0000), and a validated signed-money amount, which
// monetaryCell below writes as such a number. Typed text has no other exception: userCell neutralises even -5.
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
export const csvCell = (c: Cell) => { const t = text(c); const s = PLAIN_NUMBER.test(t) ? t : neutral(t); return /[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export const toCSV = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
export const userCell = (v: string | readonly string[]) => neutral(typeof v === 'string' ? v : v.join('; '));
// imported here, not above: the parity register cites the lines above by number (register-dispositions.mjs)
import { centsText } from '../calculations/money.ts';
import { parseAmount } from '../views/registers/amounts.ts';
/** A signed-money amount the parser accepts, as a plain number (-500.00) a spreadsheet sums; anything else as userCell. */
export function monetaryCell(raw: string): string {
	const amount = parseAmount(raw, 'signed-money');
	return amount.kind === 'ok' ? centsText(amount.units) : userCell(raw);
}

import { download as save } from './download.ts';
export const download = (name: string, content: string | Uint8Array, type = 'text/csv;charset=utf-8') => save(name, content, type);
