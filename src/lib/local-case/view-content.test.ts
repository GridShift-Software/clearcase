// The views' access to the package's view-content dataset and the date-basis probe, on synthetic values only.
import { describe, expect, it } from 'vitest';
import { readViewContent } from '../case-package/view-content.ts';
import { anyDateBasis } from './documents.server.ts';
import { EXPORT_COLUMNS_NOTE, EXPORT_NAME_NOTE, exportColumns, exportFileName, viewText } from './results.server.ts';
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

describe('export names and CSV keys for views', () => {
	const NEUTRAL_KEYS = ['point', 'documents', 'rebuttal', 'answer', 'status'];
	const of = (value: unknown, field = 'exportFileName') => readViewContent({ syn_tab: { [field]: value } });
	const name = (value: unknown, neutral = 'neutral.csv') => exportFileName(of(value), 'syn_tab', neutral);
	const keys = (value: unknown) => exportColumns(of(value, 'exportColumns'), 'syn_tab', NEUTRAL_KEYS);

	it("uses the package's bare file name, with no note", () => {
		expect(name('Syn_Example_chronology.csv')).toEqual({ name: 'Syn_Example_chronology.csv', note: null });
		expect(name('syn register.CSV')).toEqual({ name: 'syn register.CSV', note: null });
		expect(name('syn-deadlines.ics', 'deadlines.ics')).toEqual({ name: 'syn-deadlines.ics', note: null });
		expect(name('s'.repeat(124) + '.csv')).toEqual({ name: 's'.repeat(124) + '.csv', note: null });
		const vc = readViewContent({ syn_tab: { registerExportFileName: 'syn-register.csv' } });
		expect(exportFileName(vc, 'syn_tab', 'register.csv', 'registerExportFileName')).toEqual({ name: 'syn-register.csv', note: null });
	});

	it('falls back to the neutral name with the fixed note for an absent, unusable or unsafe value, never to a case value', () => {
		const refused: unknown[] = [
			undefined, '', '   ', ['syn.csv'], 7, { template: ['syn', { param: 'x' }, '.csv'] },
			'syn.txt', 'syn', 'syn.csv.exe', 'syn.', '.csv', '.syn.csv',
			'../syn.csv', 'a/syn.csv', 'a\\syn.csv', '..', 'syn..csv', '/etc/syn.csv', 'C:\\syn.csv',
			'syn\u0000.csv', 'syn\n.csv', 'syn\u0085.csv', 'syn\u007f.csv', '\u202esyn.csv', 'syn\u200b.csv', 'syn\u2066x\u2069.csv', '\ufeffsyn.csv',
			' syn.csv', 'syn.csv ', '\tsyn.csv', 's'.repeat(125) + '.csv',
		];
		for (const v of refused) expect(name(v), JSON.stringify(v)).toEqual({ name: 'neutral.csv', note: EXPORT_NAME_NOTE });
		expect(exportFileName(readViewContent(null), 'syn_tab', 'neutral.csv')).toEqual({ name: 'neutral.csv', note: EXPORT_NAME_NOTE });
		expect(EXPORT_NAME_NOTE).toMatch(/^[A-Z][^<>&]+\.$/);
	});

	it("uses the package's CSV keys when they match the neutral count and are safe", () => {
		const k = ['syn_point', 'documents', 'syn_rebuttal', 'org_answer', 'status'];
		expect(keys(k)).toEqual({ keys: k, note: null });
		expect(keys(['a', 'b', 'c', 'd', 'a=b-c+d@e'])).toEqual({ keys: ['a', 'b', 'c', 'd', 'a=b-c+d@e'], note: null }); // only a leading sign is refused
		expect(keys(['a', 'b', 'c', 'd', 'e'.repeat(64)])).toEqual({ keys: ['a', 'b', 'c', 'd', 'e'.repeat(64)], note: null });
	});

	it('falls back to the neutral keys with the fixed note for a wrong count, duplicates or unsafe keys', () => {
		const five = (last: string) => ['syn_point', 'documents', 'syn_rebuttal', 'org_answer', last];
		const refused: unknown[] = [
			undefined, 'syn_point', ['syn_point'], five('status').concat('refs'), five('documents'), five(''), five('e'.repeat(65)),
			five('=SUM(A1)'), five('+1'), five('-1'), five('@x'), five('a,b'), five('a"b'), five("a'b"), five('a\rb'), five('a\nb'), five('a\u0000b'), five('\u202estatus'), five('sta\u200btus'),
		];
		for (const v of refused) expect(keys(v), JSON.stringify(v)).toEqual({ keys: NEUTRAL_KEYS, note: EXPORT_COLUMNS_NOTE });
		expect(EXPORT_COLUMNS_NOTE).toMatch(/^[A-Z][^<>&]+\.$/);
		// the caller's neutral list is never handed out to be mutated
		const r = keys(undefined);
		r.keys.push('x');
		expect(NEUTRAL_KEYS).toHaveLength(5);
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
