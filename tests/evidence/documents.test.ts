// Documents model (GRS-14): every imported bundle is selectable (S-bundle4, S-documents-1), counts come from the rows
// (S-documents-2), v5's filter fields, type tallies, type-then-date order as labelled (BA-17, S-documents-3) and
// v5's 60-row pages. Synthetic rows.
import { beforeEach, describe, expect, it } from 'vitest';
import { documentsModel } from '../../src/lib/views/evidence/documents.ts';
import { paginate, pageParam } from '../../src/lib/views/evidence/common.ts';
import { listRow, resetOrd } from './rows.ts';

beforeEach(resetOrd);

describe('documents', () => {
	it('offers every bundle in order of first appearance, counted from the rows, and defaults to the first', () => {
		const rows = [listRow('OD-1'), listRow('VDM-1', { bundle: 'Additional' }), listRow('EM-1', { bundle: 'Correspondence' }), listRow('VDM-2', { bundle: 'Additional' })];
		const m = documentsModel(rows, { bundle: null, q: '', page: 1 });
		expect(m.bundles.map(({ name, count }) => ({ name, count }))).toEqual([{ name: 'Original', count: 1 }, { name: 'Additional', count: 2 }, { name: 'Correspondence', count: 1 }]);
		expect(m.bundle).toBe('Original');
		expect(documentsModel(rows, { bundle: 'Additional', q: '', page: 1 }).page.slice.map((r) => r.ref)).toEqual(['VDM-1', 'VDM-2']);
		expect(documentsModel(rows, { bundle: 'Nope', q: '', page: 1 })).toMatchObject({ bundle: 'Original', unknownBundle: true });
	});

	it('filters on filename, ref, subject and excerpt, not sender, case-insensitively', () => {
		const rows = [listRow('OD-1', { subject: 'Synthetic Alpha' }), listRow('OD-2', { excerpt: 'beta ALPHA' }), listRow('OD-3', { sender: 'alpha@sender' }), listRow('OD-4', { filename: 'gamma.pdf' })];
		expect(documentsModel(rows, { bundle: null, q: 'alpha', page: 1 }).page.slice.map((r) => r.ref)).toEqual(['OD-1', 'OD-2']);
		expect(documentsModel(rows, { bundle: null, q: 'od-4', page: 1 }).page.slice.map((r) => r.ref)).toEqual(['OD-4']);
		expect(documentsModel(rows, { bundle: null, q: 'zzz', page: 1 }).page).toMatchObject({ total: 0, from: 0, to: 0, pages: 1 });
	});

	it('orders by type, then date with undated first, keeping a type together when another type starts with its name', () => {
		const rows = [
			listRow('A', { docType: 'invoice', date: '2010-01-01' }), listRow('B', { docType: 'invoice breakdown', date: '2009-01-01' }),
			listRow('C', { docType: 'invoice', date: '' }), listRow('D', { docType: 'email', date: '2011-01-01' }), listRow('E', { docType: 'invoice', date: '2008-01-01' }),
		];
		const m = documentsModel(rows, { bundle: null, q: '', page: 1 });
		expect(m.page.slice.map((r) => r.ref)).toEqual(['D', 'C', 'E', 'A', 'B']);
		expect(m.types).toEqual([{ type: 'email', count: 1 }, { type: 'invoice', count: 3 }, { type: 'invoice breakdown', count: 1 }]);
		expect(m.page.slice.find((r) => r.ref === 'B')).toMatchObject({ title: 'B synthetic', type: 'invoice breakdown', date: '2009-01-01' });
	});

	it('pages 60 rows as v5 does, clamping the page, and reads a page parameter strictly', () => {
		const rows = Array.from({ length: 125 }, (_, i) => listRow(`OD-${String(i).padStart(3, '0')}`));
		expect(documentsModel(rows, { bundle: null, q: '', page: 3 }).page).toMatchObject({ page: 3, pages: 3, from: 121, to: 125, total: 125 });
		expect(documentsModel(rows, { bundle: null, q: '', page: 99 }).page.page).toBe(3);
		expect(paginate([], 0, 60)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 });
		expect([pageParam('2'), pageParam('0'), pageParam('-1'), pageParam('x'), pageParam(null)]).toEqual([2, 1, 1, 1, 1]);
	});
});
