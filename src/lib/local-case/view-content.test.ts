// The views' access to the package's view-content dataset and the date-basis probe, on synthetic values only.
import { describe, expect, it } from 'vitest';
import { readViewContent } from '../case-package/view-content.ts';
import { anyDateBasis } from './documents.server.ts';
import { viewText } from './results.server.ts';
import type { CaseStore } from './store.server.ts';

describe('view-content text for views', () => {
	const vc = readViewContent({
		overview: { subtitle: 'Synthetic Co v Example Ltd', kpiDocumentsNote: { template: ['across ', { param: 'bundleCount' }, ' bundles'] }, kpiInvoicesNote: { template: ['in ', { param: 'unknownParam' }] }, blank: '  ' },
		_shell: { brandName: 'Synth v Example', count: 3 },
	});
	it('returns plain text as stored and fills templates from the given imported values', () => {
		expect(viewText(vc, 'overview', 'subtitle')).toBe('Synthetic Co v Example Ltd');
		expect(viewText(vc, 'overview', 'kpiDocumentsNote', { bundleCount: 5 })).toBe('across 5 bundles');
		expect(viewText(vc, '_shell', 'brandName')).toBe('Synth v Example');
	});
	it('gives null, so the view keeps its neutral layout, for absent, blank, non-text or unfillable fields', () => {
		expect(viewText(vc, 'overview', 'kpiInvoicesNote', { bundleCount: 5 })).toBeNull();
		expect(viewText(vc, 'overview', 'kpiDocumentsNote')).toBeNull();
		expect(viewText(vc, 'overview', 'blank')).toBeNull();
		expect(viewText(vc, '_shell', 'count')).toBeNull();
		expect(viewText(vc, '_shell', 'documentTitle')).toBeNull();
		expect(viewText(readViewContent(null), 'overview', 'subtitle')).toBeNull();
	});
});

describe('date basis probe', () => {
	const store = (rows: unknown[] | null) => ({ chronologyJson: () => (rows ? JSON.stringify(rows) : null) }) as unknown as CaseStore;
	it('is true only when some row has a supplied date type, whatever the row texts contain', () => {
		expect(anyDateBasis(store([{ ref: 'A', dateType: null }, { ref: 'B', dateType: 'issued' }]), 'v')).toBe(true);
		expect(anyDateBasis(store([{ ref: 'A', dateType: null, excerpt: '"dateType":"sent"' }]), 'v')).toBe(false);
		expect(anyDateBasis(store([]), 'v')).toBe(false);
		expect(anyDateBasis(store(null), 'v')).toBe(false);
	});
});
