// CSV quoting against spreadsheets that split on `;` or tab (CC-07 verify lane 03): a cell holding one is quoted, so it
// stays one cell there when it is a row's first; `,`-separated values are unchanged. A user cell in a later column
// (CC-08 verify lane 03) is kept safe by userCell: no `;`, tab or line segment of it starts with a formula character.
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
	it('quotes a cell with a `;`, which a `;`-separated parse reads back as one cell', () => {
		const value = 'x;=1+1'; // an imported value: exported unchanged
		const csv = toCSV([['note'], [value]]);
		expect(csv).toBe('note\r\n"x;=1+1"');
		expect(parse(csv, ';')).toEqual([['note'], [value]]);
		expect(parse(csv, ',')).toEqual([['note'], [value]]);
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

/**
 * A reader that splits on `sep` and on line ends and honours a quote only where it opens a field, as a spreadsheet
 * does: in `T,A,"x;=1"` split on `;` the quote is text inside `T,A,"x`.
 */
function splitLike(text: string, sep: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = '', q = false, fresh = true;
	const end = () => { row.push(cell); cell = ''; fresh = true; };
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
		if (c === '"' && fresh) { q = true; fresh = false; }
		else if (c === sep) end();
		else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; end(); rows.push(row); row = []; }
		else { cell += c; fresh = false; }
	}
	end(); rows.push(row);
	return rows;
}
/** A field a spreadsheet would run as a formula: its first non-space character is =, +, -, @, tab or CR. */
const formula = (f: string) => /^ *[=+\-@\t\r]/.test(f);

describe('user cells in any column of a multi-column row (CC-08 verify lane 03)', () => {
	const cases: [string, string][] = [
		['x;=1+1', "x;'=1+1"],
		['x;=1+1;', "x;'=1+1;"],
		['x; @SUM(A1)', "x; '@SUM(A1)"],
		['x\t=1', "x\t'=1"],
		['x\r\n=1', "x\r\n'=1"],
		['x\n-1', "x\n'-1"],
	];
	const rowsFor = (cell: string) => ({ first: [cell, 'B', 'C'], later: ['T', 'A', cell] });
	describe.each(cases)('%j', (typed, neutral) => {
		it.each(['first', 'later'] as const)('in the %s column: one `,`-separated cell holding the neutralised text', (at) => {
			expect(userCell(typed)).toBe(neutral);
			const row = rowsFor(userCell(typed))[at];
			expect(parseCsv(toCSV([row]))).toEqual([row]);
			expect(parse(toCSV([row]), ',')).toEqual([row]);
		});
		it.each(['first', 'later'] as const)('in the %s column: no `;`, tab or line field starts with a formula character', (at) => {
			const csv = toCSV([rowsFor(userCell(typed))[at]]);
			const fields = [...splitLike(csv, ';').flat(), ...splitLike(csv, '\t').flat(), ...csv.split(/\r\n|\r|\n/)];
			expect(fields.filter(formula)).toEqual([]);
		});
	});
	it('keeps a plain cell, an inner sign and an imported value as they are', () => {
		expect([userCell('a-b; c+d'), userCell('x;y'), userCell('1;2')]).toEqual(['a-b; c+d', 'x;y', '1;2']);
		expect(csvCell('x;=1+1')).toBe('"x;=1+1"');
	});
});
