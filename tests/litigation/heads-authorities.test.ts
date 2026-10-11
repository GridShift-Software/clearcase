// Heads of Argument and Authorities (GRS-18): evidence refs, the skeleton export (with and without the caption, and
// empty), and the authorities CSV (imported rows unchanged, then user rows through userCell).
import { describe, expect, it } from 'vitest';
import { AUTH_FILE, authoritiesCsv, canAddAuthority } from '../../src/lib/views/litigation/authorities.ts';
import { HEADS_FILE, canAddHead, evidenceTokens, exportLine, headsText, splitRefs } from '../../src/lib/views/litigation/heads.ts';

describe('heads evidence refs', () => {
	it('splits on spaces and commas only (S-heads_tab-2, copied)', () => {
		expect(splitRefs('OD-1, XX-9')).toEqual(['OD-1', 'XX-9']);
		expect(splitRefs('OD-1;SD-2')).toEqual(['OD-1;SD-2']);
		expect(splitRefs('  ,, ')).toEqual([]);
		expect(splitRefs('')).toEqual([]);
	});
	it('links only a token that names a document row exactly; never fuzzy', () => {
		const docs = new Set(['OD-1', 'SD-2']);
		expect(evidenceTokens('OD-1, XX-9 od-1 OD-01 SD-2', (r) => docs.has(r))).toEqual([
			{ text: 'OD-1', ref: true }, { text: 'XX-9', ref: false }, { text: 'od-1', ref: false }, { text: 'OD-01', ref: false }, { text: 'SD-2', ref: true },
		]);
	});
});

describe('headsText (v5 exportHeads)', () => {
	const row = { head: 'H', sub: 'S', auth: 'A', ref: 'OD-1, XX-9' };
	it('starts with the literal heading and the view-content caption, then a blank line', () => {
		expect(headsText([row], 'Party v Other')).toBe('HEADS OF ARGUMENT — Party v Other\n\n1. H\n   S\n   Authority: A\n   Evidence: OD-1, XX-9\n\n');
	});
	it('without a caption, starts "HEADS OF ARGUMENT" and a blank line', () => {
		expect(headsText([row], null)).toBe('HEADS OF ARGUMENT\n\n1. H\n   S\n   Authority: A\n   Evidence: OD-1, XX-9\n\n');
	});
	it('with no submissions holds only the header line and the blank line', () => {
		expect(headsText([], 'Party v Other')).toBe('HEADS OF ARGUMENT — Party v Other\n\n');
		expect(headsText([], null)).toBe('HEADS OF ARGUMENT\n\n');
	});
	it('numbers the submissions in order', () => {
		expect(headsText([row, { ...row, head: 'H2' }], null)).toContain('\n2. H2\n');
	});
	it('needs a heading or a submission to add (v5 addHead), and has a generic file name', () => {
		expect(canAddHead({ head: '', sub: '', auth: 'A', ref: 'R' })).toBe(false);
		expect(canAddHead({ head: 'H', sub: '', auth: '', ref: '' })).toBe(true);
		expect(canAddHead({ head: '', sub: 'S', auth: '', ref: '' })).toBe(true);
		expect(HEADS_FILE).toBe('heads_of_argument.txt');
	});
});

describe('authoritiesCsv (v5 exportAuth)', () => {
	it('writes the header, imported rows unchanged, then user rows with formulas neutralised', () => {
		const csv = authoritiesCsv([{ topic: 'T1', authority: '=imported', proposition: 'P, with comma' }], [{ topic: 'T2', authority: '=SUM(A1)', proposition: 'mine' }]);
		const lines = csv.split('\r\n');
		expect(lines[0]).toBe('topic,authority,proposition');
		expect(lines[1]).toBe('T1,=imported,"P, with comma"');
		expect(lines[2]).not.toContain(',=SUM');
		expect(lines[2]).toMatch(/^T2,.+SUM\(A1\),mine$/);
		expect(lines).toHaveLength(3);
	});
	it('needs an authority to add (v5 addAuth), and has a generic file name', () => {
		expect(canAddAuthority({ topic: 'T', authority: '', proposition: 'P' })).toBe(false);
		expect(canAddAuthority({ topic: '', authority: 'A', proposition: '' })).toBe(true);
		expect(AUTH_FILE).toBe('authorities.csv');
	});
});

describe('headsText normalises user fields (GRS-18 r2, D19)', () => {
	it('a heading with CRLF and a numbered line cannot forge a second submission', () => {
		const out = headsText([{ head: 'H\r\n2. Forged heading', sub: 'S', auth: '', ref: '' }], null);
		expect(out).toBe('HEADS OF ARGUMENT\n\n1. H 2. Forged heading\n   S\n   Authority: \n   Evidence: \n\n');
		expect(out.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
	});
	it.each([['CR', '\r'], ['LF', '\n'], ['CRLF', '\r\n'], ['NEL', '\u0085'], ['LS', '\u2028'], ['PS', '\u2029'], ['VT', '\v'], ['FF', '\f']])('%s becomes one space', (_n, c) => {
		expect(exportLine(`a${c}b`)).toBe('a b');
		expect(exportLine(`a${c}${c}b`)).toBe('a b');
	});
	it.each([['NUL', '\u0000'], ['BEL', '\u0007'], ['BS', '\b'], ['ESC', '\u001b'], ['US', '\u001f'], ['DEL', '\u007f']])('%s is dropped', (_n, c) => {
		expect(exportLine(`a${c}b`)).toBe('ab');
	});
	it('keeps tabs and ordinary text, and leaves the stored value alone', () => {
		const row = { head: 'a\tb', sub: 'é ß', auth: '', ref: '' };
		expect(exportLine(row.head)).toBe('a\tb');
		headsText([row], null);
		expect(row.head).toBe('a\tb');
	});
});
