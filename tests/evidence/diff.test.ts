// Document Diff (GRS-14): v5's word and line diff on literal synthetic texts (view-checklist examples), an explicit
// pair only (BA-06), every excerpt-bearing document selectable (S-hoa_diff_tab-1) and the compared coverage.
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_CELLS, candidates, compare, diffLines, diffWords } from '../../src/lib/views/evidence/diff.ts';
import { listRow, resetOrd } from './rows.ts';

beforeEach(resetOrd);

describe('diff', () => {
	it('words: the cat sat / the dog sat', () => {
		expect(diffWords('the cat sat', 'the dog sat')).toEqual([{ op: 'eq', text: 'the ' }, { op: 'del', text: 'cat' }, { op: 'add', text: 'dog' }, { op: 'eq', text: ' sat' }]);
	});
	it('lines: x/y against x/z, the separator after each token as v5 emits it', () => {
		expect(diffLines('x\ny', 'x\nz')).toEqual([{ op: 'eq', text: 'x\n' }, { op: 'del', text: 'y' }, { op: 'eq', text: '\n' }, { op: 'add', text: 'z' }, { op: 'eq', text: '\n' }]);
	});
	it('deletes before it inserts, and leaves equal texts unchanged', () => {
		expect(diffWords('a b', 'c d')).toEqual([{ op: 'del', text: 'a' }, { op: 'add', text: 'c' }, { op: 'eq', text: ' ' }, { op: 'del', text: 'b' }, { op: 'add', text: 'd' }]);
		expect(diffWords('same text', 'same text')).toEqual([{ op: 'eq', text: 'same text' }]);
	});

	it('offers every document with an excerpt, beyond v5s first 1,200', () => {
		const rows = Array.from({ length: 1300 }, (_, i) => listRow(`OD-${String(i).padStart(4, '0').slice(-4)}`, { excerpt: i % 10 === 9 ? '' : `text ${i}`, filename: `(${i}) Synthetic ${i}.pdf` }));
		const c = candidates(rows);
		expect(c).toHaveLength(1170);
		expect(c[0]).toEqual({ ref: rows[0]!.ref, label: `${rows[0]!.ref} · Synthetic 0` });
	});

	it('compares only an explicitly chosen pair, and states the compared coverage', () => {
		const rows = [listRow('OD-1', { excerpt: 'the cat sat', textStatus: 'extracted' }), listRow('OD-2', { excerpt: 'the dog sat', textStatus: 'none', filename: '(2) Second.pdf' })];
		expect(compare(rows, null, null, null, false)).toEqual({ kind: 'none' });
		expect(compare(rows, 'OD-1', '', 'words', true)).toEqual({ kind: 'pick', reasons: [] });
		expect(compare(rows, 'OD-1', 'ZZ-404', 'words', true)).toEqual({ kind: 'pick', reasons: ['Document B “ZZ-404” is not a document of this results version.'] });
		const r = compare(rows, 'OD-1', 'OD-2', 'words', true);
		expect(r).toMatchObject({ kind: 'diff', mode: 'words', same: false, a: { ref: 'OD-1', chars: 11, textStatus: 'extracted' }, b: { ref: 'OD-2', name: 'Second', chars: 11, textStatus: 'none' } });
		expect(compare(rows, 'OD-1', 'OD-1', 'lines', true)).toMatchObject({ kind: 'diff', mode: 'lines', same: true });
	});

	it('does not compare documents without an excerpt chosen by URL, and says why (D11)', () => {
		const rows = [listRow('OD-1', { excerpt: 'the cat sat' }), listRow('OD-5', { excerpt: '' }), listRow('OD-6', { excerpt: '' })];
		expect(compare(rows, 'OD-5', 'OD-6', 'words', true)).toEqual({ kind: 'pick', reasons: ['Document A OD-5 has no indexed excerpt, so it cannot be compared.', 'Document B OD-6 has no indexed excerpt, so it cannot be compared.'] });
		expect(compare(rows, 'OD-1', 'OD-5', 'words', true)).toMatchObject({ kind: 'pick', reasons: ['Document B OD-5 has no indexed excerpt, so it cannot be compared.'] });
	});

	it(`refuses a pair whose LCS table would pass ${MAX_CELLS} cells, and compares one at the bound (D10)`, () => {
		// words mode keeps the whitespace: n words are 2n - 1 tokens
		const text = (n: number, w: string) => Array.from({ length: n }, () => w).join(' ');
		const tokens = (t: string) => t.split(/(\s+)/).length;
		const [a2001, b1999, b2001] = [text(1001, 'a'), text(1000, 'b'), text(1001, 'b')];
		expect([tokens(a2001), tokens(b1999), 2001 * 1999 <= MAX_CELLS, 2001 * 2001 > MAX_CELLS]).toEqual([2001, 1999, true, true]);
		const at = [listRow('OD-1', { excerpt: a2001 }), listRow('OD-2', { excerpt: b1999 })];
		expect(compare(at, 'OD-1', 'OD-2', 'words', true)).toMatchObject({ kind: 'diff' });
		const over = [listRow('OD-1', { excerpt: a2001 }), listRow('OD-2', { excerpt: b2001 })];
		expect(compare(over, 'OD-1', 'OD-2', 'words', true)).toMatchObject({ kind: 'too-long', mode: 'words', cells: 2001 * 2001, a: { ref: 'OD-1' }, b: { ref: 'OD-2' } });
		// the same texts in lines mode are one token a side
		expect(compare(over, 'OD-1', 'OD-2', 'lines', true)).toMatchObject({ kind: 'diff', mode: 'lines' });
		// today's longest excerpts (500 characters) stay far below the bound
		expect(Math.ceil(500 / 2) * 2 * Math.ceil(500 / 2) * 2).toBeLessThan(MAX_CELLS / 10);
	});
});
