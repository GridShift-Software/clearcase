import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../scripts/parity/lib/exports.mjs';
import { csvCell, toCSV, userCell, type Cell } from './csv.ts';

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

const before = (rows: readonly (readonly Cell[])[]) =>
	rows.map((r) => r.map((c) => { const s = c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }).join(',')).join('\r\n');

describe('CSV cells with a semicolon or tab', () => {
	it('quotes a cell with a `;`, which a `;`-separated parse reads back as one cell', () => {
		const value = 'x;y+1';
		const csv = toCSV([['note'], [value]]);
		expect(csv).toBe('note\r\n"x;y+1"');
		expect(parse(csv, ';')).toEqual([['note'], [value]]);
		expect(parse(csv, ',')).toEqual([['note'], [value]]);
	});

	it('quotes a cell with a tab, which a tab-separated parse reads back as one cell', () => {
		expect(csvCell('x\ty+1')).toBe('"x\ty+1"');
		expect(parse(toCSV([['x\ty+1']]), '\t')).toEqual([['x\ty+1']]);
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
		expect(now).not.toBe(before(rows));
		expect(parse(now, ',')).toEqual(parse(before(rows), ','));
		expect(parseCsv(now)).toEqual(parseCsv(before(rows)));
		expect(parseCsv(now)).toEqual(rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c)))));
	});
});

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
	it('keeps a plain cell and an inner sign as they are', () => {
		expect([userCell('a-b; c+d'), userCell('x;y'), userCell('1;2')]).toEqual(['a-b; c+d', 'x;y', '1;2']);
		expect([csvCell('a-b; c+d'), csvCell('x;y'), csvCell('1;2')]).toEqual(['"a-b; c+d"', '"x;y"', '"1;2"']);
	});
	it('neutralises a quote that starts a segment, and is idempotent', () => {
		expect(userCell('a;"=1+1"')).toBe(`a;'"=1+1"`);
		expect(csvCell('a;"=1+1"')).toBe(`"a;'""=1+1"""`);
		const csv = toCSV([['T', 'A', userCell('a;"=1+1"')]]);
		expect(splitLike(csv, ';').flat().filter((f) => /^ *["=+\-@\t\r]/.test(f))).toEqual([]);
		for (const typed of ['x;=1', 'x\r\n=1', 'a;"b"']) expect(userCell(userCell(typed))).toBe(userCell(typed));
	});
	it('joins a user array cell with "; " before the start and segment rules', () => {
		expect(userCell(['=SUM(A1)', ' =x', 'ok'])).toBe(`'=SUM(A1);  '=x; ok`);
		expect(userCell(['a', '=x'])).toBe(userCell('a; =x'));
		expect(csvCell(['a', ' =x'])).toBe(`"a;  '=x"`);
	});
});

describe('imported cells in any column of a multi-column row (BASE-R2g)', () => {
	const cases: [string, string][] = [
		['x;=HYPERLINK("http://a")', `x;'=HYPERLINK("http://a")`],
		['x\t=1', "x\t'=1"],
		['x\r\n=1', "x\r\n'=1"],
		['x\n-1', "x\n'-1"],
	];
	const rowsFor = (cell: string) => ({ first: [cell, 'B', 'C'], later: ['T', 'A', cell] });
	describe.each(cases)('%j', (imported, neutral) => {
		it.each(['first', 'later'] as const)('in the %s column: one `,`-separated cell holding the neutralised text', (at) => {
			const csv = toCSV([rowsFor(imported)[at]]);
			expect(parseCsv(csv)).toEqual([rowsFor(neutral)[at]]);
			expect(parse(csv, ',')).toEqual([rowsFor(neutral)[at]]);
		});
		it.each(['first', 'later'] as const)('in the %s column: no `;`, tab or line field starts with a formula character', (at) => {
			const csv = toCSV([rowsFor(imported)[at]]);
			const fields = [...splitLike(csv, ';').flat(), ...splitLike(csv, '\t').flat(), ...csv.split(/\r\n|\r|\n/)];
			expect(fields.filter(formula)).toEqual([]);
		});
	});
	it("leaves an imported cell's own first character alone (v5 parity)", () => {
		expect([csvCell('=A1'), csvCell('-5'), csvCell(-5), csvCell('@x')]).toEqual(['=A1', '-5', '-5', '@x']);
	});
});
