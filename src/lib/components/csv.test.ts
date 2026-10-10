// CSV quoting against spreadsheets that split on `;` or tab (CC-07 verify lane 03): a cell holding one is quoted, so it
// stays one cell there and text after the separator cannot run as a formula; `,`-separated values are unchanged.
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../scripts/parity/lib/exports.mjs';
import { csvCell, toCSV, userCell, type Cell } from './csv.ts';

/** RFC 4180 with a chosen separator: quoted cells keep separators and newlines, a doubled quote is one quote. */
function parse(text: string, sep: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = '', q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
		if (c === '"') q = true;
		else if (c === sep) { row.push(cell); cell = ''; }
		else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
		else cell += c;
	}
	if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
	return rows;
}

/** The quoting before this change (quote, comma, CR, LF only), to show `,`-separated values are unchanged. */
const before = (rows: readonly (readonly Cell[])[]) =>
	rows.map((r) => r.map((c) => { const s = c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }).join(',')).join('\r\n');

describe('CSV cells with a semicolon or tab', () => {
	it('quotes a user cell with a `;` before a formula, which a `;`-separated parse reads back as one cell', () => {
		const typed = 'x;=1+1';
		expect(userCell(typed)).toBe(typed); // only a leading formula character is neutralised
		const csv = toCSV([['note'], [userCell(typed)]]);
		expect(csv).toBe('note\r\n"x;=1+1"');
		expect(parse(csv, ';')).toEqual([['note'], [typed]]);
		expect(parse(csv, ',')).toEqual([['note'], [typed]]);
	});

	it('quotes a cell with a tab, which a tab-separated parse reads back as one cell', () => {
		expect(csvCell('x\t=1+1')).toBe('"x\t=1+1"');
		expect(parse(toCSV([['x\t=1+1']]), '\t')).toEqual([['x\t=1+1']]);
	});

	it('round-trips an array cell, now quoted because it is joined with "; "', () => {
		const csv = toCSV([['refs', 'n'], [['OD-1', 'SD-2'], 3]]);
		expect(csv).toBe('refs,n\r\n"OD-1; SD-2",3');
		expect(parse(csv, ',')).toEqual([['refs', 'n'], ['OD-1; SD-2', '3']]);
	});

	it('gives `,`-separated cell values identical to the quoting before, also as the parity harness parses them', () => {
		const rows: Cell[][] = [
			['plain', 'a;b', 'tab\there', 'comma, here', 'say "hi"', 'multi\nline', 'cr\ronly', ['p', 'q'], null, undefined, 42, ''],
			[userCell('=SUM(A1)'), userCell('x;=1+1'), userCell('+1'), ';', '\t', ';;', 'x;', ';x'],
		];
		const now = toCSV(rows);
		expect(now).not.toBe(before(rows)); // the bytes differ (more cells are quoted) ...
		expect(parse(now, ',')).toEqual(parse(before(rows), ',')); // ... the values do not
		expect(parseCsv(now)).toEqual(parseCsv(before(rows)));
		expect(parseCsv(now)).toEqual(rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c)))));
	});
});
