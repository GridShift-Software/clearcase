import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../scripts/parity/lib/exports.mjs';
import { csvCell, monetaryCell, toCSV, userCell, type Cell } from './csv.ts';

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
		// GRS-172: the one cell that starts a formula, the lone tab, now starts with a `'`; every other value is as before
		const was = rows.map((r) => r.map((c) => (c === '\t' ? "'\t" : c)));
		expect(now).not.toBe(before(rows));
		expect(parse(now, ',')).toEqual(parse(before(was), ','));
		expect(parseCsv(now)).toEqual(parseCsv(before(was)));
		expect(parseCsv(now)).toEqual(was.map((r) => r.map((c) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c)))));
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
	it("neutralises an imported cell's own first character, except in a plain number (GRS-172)", () => {
		expect([csvCell('=A1'), csvCell('-5'), csvCell(-5), csvCell('@x')]).toEqual(["'=A1", '-5', '-5', "'@x"]);
	});
});

describe('explicit monetary CSV cells (GRS-49)', () => {
	it.each([
		['-500', '-500.00'], ['-500.25', '-500.25'], ['-R 1 250.50', '-1250.50'],
		['-999999999999.99', '-999999999999.99'], ['R 1,250.50', '1250.50'], ['0', '0.00'], [' -500 ', '-500.00'],
	])('exports the validated monetary amount %j as a numeric CSV cell', (raw, numeric) => {
		expect(toCSV([['amount'], [monetaryCell(raw)]])).toBe(`amount\r\n${numeric}`);
		expect(userCell(raw)).toBe(/^ *-/.test(raw) ? `'${raw}` : raw); // GRS-172: spaces before the sign do not hide it
	});
	it.each(['-1+2', '-1e3', '-12,34', '-5.001', '-1000000000000', '=1', '@SUM(A1)', '', 'plain'])('does not exempt malformed monetary text %j', (raw) => {
		expect(monetaryCell(raw)).toBe(userCell(raw));
	});
	for (const sep of [';', '\t', '\r', '\n']) {
		for (const lead of ['=', '+', '-', '@', '"']) {
			it(`neutralises free text after ${JSON.stringify(sep)} and ${lead} in every column`, () => {
				const raw = `-500${sep} ${lead}1`;
				for (let col = 0; col < 3; col++) {
					const cells = ['synthetic', 'synthetic', 'synthetic'];
					cells[col] = monetaryCell(raw);
					expect(cells[col]).toBe(userCell(raw));
					expect(cells[col]).toContain(`${sep} '${lead}1`);
					expect(parseCsv(toCSV([cells]))).toEqual([cells]);
				}
			});
		}
	}
});

describe('imported cells that start a formula, in any column (GRS-172)', () => {
	const rowsFor = (cell: string) => ({ first: [cell, 'B', 'C'], later: ['T', 'A', cell] });
	describe.each(['=', '+', '-', '@', '\t', '\r'])('%j', (lead) => {
		const imported = `${lead}SYN(1)`;
		it.each(['first', 'later'] as const)("in the %s column: one cell that holds the imported text after a `'`", (at) => {
			const csv = toCSV([rowsFor(imported)[at]]);
			expect(parseCsv(csv)).toEqual([rowsFor(`'${imported}`)[at]]);
			expect(parse(csv, ',')).toEqual([rowsFor(`'${imported}`)[at]]);
			expect(parse(csv, ',').flat().filter(formula)).toEqual([]);
		});
		it('is written as userCell writes the same text typed', () => {
			expect(csvCell(imported)).toBe(csvCell(userCell(imported)));
		});
	});
	it.each(['-5', '-500.00', '-0.5', '0', '42', '1150.00'])('keeps the plain number %j, so a spreadsheet reads a number', (n) => {
		expect(csvCell(n)).toBe(n);
		expect(parseCsv(toCSV([['T', n]]))).toEqual([['T', n]]);
	});
	it('keeps a number cell, negative included', () => {
		expect([csvCell(-5), csvCell(-500.25), csvCell(0)]).toEqual(['-5', '-500.25', '0']);
	});
	it.each([
		['-1+2', "'-1+2"], ['-1e3', "'-1e3"], ['-', "'-"], ['-.5', "'-.5"], ['--5', "'--5"], ['-5 ', "'-5 "], ['-R 500', "'-R 500"],
		['-1,250.50', `"'-1,250.50"`], ['+5', "'+5"], ['+27820000000', "'+27820000000"], ['+27 82 000 0000', "'+27 82 000 0000"],
	])('neutralises %j, which is not a plain number', (raw, cell) => {
		expect(csvCell(raw)).toBe(cell);
	});
	it('keeps a validated signed amount numeric (GRS-49) beside imported text that is neutralised', () => {
		expect(toCSV([[monetaryCell('-R 1 250.50'), monetaryCell('-500'), monetaryCell('R 1,250.50')]])).toBe('-1250.50,-500.00,1250.50');
		expect(parseCsv(toCSV([[monetaryCell('-500'), '=SYN(1)', '-SYN(1)']]))).toEqual([['-500.00', "'=SYN(1)", "'-SYN(1)"]]);
	});
	it('leaves a neutralised cell as it is when written again', () => {
		for (const s of ['=SYN(1)', '\t=1', '\r\r=1', 'x;=1', '-5', '-1+2']) expect(csvCell(csvCell(s).replace(/^"|"$/g, '').replaceAll('""', '"'))).toBe(csvCell(s));
	});
});

describe('a cell that starts with spaces and then a formula character (GRS-172 M1)', () => {
	// LibreOffice's "Trim spaces" import turns ` =1+1` into a live formula, whether the text was imported or typed
	const cases: [string, string][] = [[' =1+1', "' =1+1"], ['  +1', "'  +1"], [' -5', "' -5"], [' @SUM(A1)', "' @SUM(A1)"], [' \t=1', "' \t'=1"]];
	it.each(cases)('%j starts with a `\'` at position 0, imported (csvCell) and typed (userCell)', (raw, want) => {
		const q = (s: string) => (/[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
		expect(csvCell(raw)).toBe(q(want));
		expect(userCell(raw)).toBe(want);
		expect(parseCsv(toCSV([[raw, 'B']]))).toEqual([[want, 'B']]);
		expect(parseCsv(toCSV([[userCell(raw), 'B']]))).toEqual([[want, 'B']]);
	});
	it('matches the segment rule: after a separator the same spaces and character get a `\'`, and text with an inner space does not', () => {
		expect(userCell('x; =1+1')).toBe("x; '=1+1");
		expect(csvCell(' =1+1')).toBe("' =1+1");
		expect([csvCell('a =1+1'), csvCell(' plain'), userCell(' plain')]).toEqual(['a =1+1', ' plain', ' plain']);
	});
	it('is idempotent, and keeps the plain-number exception only for an unpadded number', () => {
		expect(userCell(userCell(' =1+1'))).toBe("' =1+1");
		expect([csvCell('-5'), csvCell(' 5'), userCell('-5')]).toEqual(['-5', ' 5', "'-5"]);
	});
});
