// CaseLines page-text search (v5 doSearch, snippet), its coverage disclosure (BA-08) and linked-path normalisation.
import { describe, expect, it } from 'vitest';
import { coverage, linkedName, linkedPath, searchPages, sizeLabel, snippet } from '../../src/lib/views/bundles/caselines';

describe('caselines search', () => {
	it('counts case-insensitive occurrences per page, ascending pages', () => {
		const r = searchPages([[3, 'Foo foo FOO'], [1, 'a foo'], [2, 'none']], ' foo ');
		expect(r.map((h) => [h.p, h.count])).toEqual([[1, 1], [3, 3]]);
		expect(searchPages([[1, 'x']], '   ')).toEqual([]);
	});
	it('stops counting a page once it exceeds 50', () => {
		expect(searchPages([[1, 'ab'.repeat(80)]], 'ab')[0]!.count).toBe(51);
	});
	it('keeps 70 characters before and 90 after the first hit, with ellipsis markers', () => {
		const t = 'x'.repeat(100) + 'HIT' + 'y'.repeat(100);
		const s = snippet(t, 100, 3);
		expect(s.pre).toBe('… ' + 'x'.repeat(70));
		expect(s.mid).toBe('HIT');
		expect(s.post).toBe('y'.repeat(90) + ' …');
	});
	it('discloses coverage: pages indexed and pages without text', () => {
		expect(coverage([[1, 'a'], [2, ' '], [3, '']], 5)).toEqual({ indexed: 3, withoutText: 2, emptyPages: [2, 3], pages: 5 });
	});
	it('normalises a linked path like v5 linkPath', () => {
		expect(linkedPath('/Folder A/x&y.pdf')).toBe('Folder A/x&y.pdf');
		expect(linkedPath('./a/b.pdf')).toBe('a/b.pdf');
		expect(linkedPath('   ')).toBeNull();
		expect(linkedName('Folder A/x&y.pdf')).toBe('x&y.pdf');
		expect(sizeLabel(2048)).toBe('2 KB');
	});
});
