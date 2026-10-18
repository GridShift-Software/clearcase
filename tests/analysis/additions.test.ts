import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisAdditionsEnabled } from '../../src/lib/analysis/data.server.ts';
import { VIEWS } from '../../src/lib/components/view-registry.ts';
import { NEUTRAL_CSV_KEYS, defenceCsv, defenceCsvKeys, refsShown } from '../../src/lib/views/analysis/defence.ts';
import { V5_HEADINGS, viewHeading } from '../../src/lib/views/analysis/headings.ts';
// defenceCsv run over these synthetic rows in a 15da042 tree; the flag must not change these bytes.
import base from './base-15da042.json';

afterEach(() => vi.unstubAllEnvs());

describe('analysis additions pending client approval (GRS-48)', () => {
	it.each([undefined, '', '0', 'false', 'true', 'yes', ' 1'])('keeps additions off for %j', (value) => {
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', value);
		expect(analysisAdditionsEnabled()).toBe(false);
	});
	it('requires the explicit opt-in value 1', () => {
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', '1');
		expect(analysisAdditionsEnabled()).toBe(true);
	});
	it('exports the base quoted and multiline bytes, refs column included', () => {
		expect(defenceCsv(base.keys, base.rows, true)).toBe(base.csv);
	});
	it('exports only v5\'s five columns while the additions are off: no refs header, no refs cell', () => {
		expect(defenceCsv(base.keys, base.rows, false)).toBe('"p,""q""",case,evidence,documents,rebuttal\r\n"Quoted ""point"",\nnext line","Their case\r\ncontinued","Evidence;\'=SUM(A1)",OD-1 SD-2,"Rebuttal, ""quoted"""\r\n,,,,');
		expect(defenceCsv(NEUTRAL_CSV_KEYS, [], false)).toBe('point,case,evidence,documents,rebuttal');
	});
	it('keeps the package keys as v5 does while the additions are off, even a key named refs', () => {
		const pkg = { keys: ['a', 'b', 'refs', 'd', 'e'], note: null };
		expect(defenceCsvKeys(pkg, 'N.', false)).toBe(pkg);
		expect(defenceCsvKeys(pkg, 'N.', true)).toEqual({ keys: [...NEUTRAL_CSV_KEYS], note: 'N.' });
	});
	it('shows the Refs column only with the additions on and a row that has refs', () => {
		const row = (refs: string) => ({ point: 'P', dcs: 'C', evidence: 'E', rebuttal: 'R', refs, docs: [] });
		expect(refsShown([row(''), row('OD-1')], false)).toBe(false);
		expect(refsShown([row(''), row('OD-1')], true)).toBe(true);
		expect(refsShown([row(''), row(' ')], true)).toBe(false);
	});
	it('heads Timeline, Defence & Rebuttal and Info Required as v5 does while the additions are off', () => {
		expect(V5_HEADINGS).toEqual({ timeline: 'Chronology & Timeline', vdm_matrix_tab: 'Defence & Rebuttal Matrix', info_required_tab: 'Information & Documents Required' });
		const label = (id: string) => VIEWS.find((v) => v.id === id)!;
		expect(viewHeading(label('timeline'), false)).toBe('Chronology & Timeline');
		expect(viewHeading(label('vdm_matrix_tab'), false)).toBe('Defence & Rebuttal Matrix');
		expect(viewHeading(label('info_required_tab'), false)).toBe('Information & Documents Required');
	});
	it('heads every view with its navigation label with the additions on, and every other view with it in both states (BA-18)', () => {
		for (const v of VIEWS) {
			expect(viewHeading(v, true)).toBe(v.label);
			if (!Object.hasOwn(V5_HEADINGS, v.id)) expect(viewHeading(v, false)).toBe(v.label);
		}
	});
});
