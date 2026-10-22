import { describe, expect, it } from 'vitest';
import { availableStatusOptions } from '../../src/lib/local-case/chronology.ts';
import { runSearch, EMPTY, type SearchRow } from '../../src/lib/views/evidence/search.ts';
import { listRow } from './rows.ts';

describe('GRS-183 evidence list corrections', () => {
	it('IDR-090 omits OCR when no document has that text status', () => {
		const rows = [listRow('OD-1', { textStatus: 'extracted' }), listRow('OD-2', { textStatus: 'none' })];
		expect(availableStatusOptions(rows)).toEqual(['extracted', 'none', 'pending']);
	});

	it('IDR-145 shows a short search excerpt without a truncation mark', () => {
		const row: SearchRow = { ...listRow('OD-1', { excerpt: 'Brief synthetic evidence.' }), cc: '' };
		const result = runSearch([row], EMPTY, true, 1);
		if (result.kind !== 'results') throw new Error('expected search results');
		expect(result.page.slice[0]?.excerpt).toBe('Brief synthetic evidence.');
	});
});
