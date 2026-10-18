import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisAdditionsEnabled, analysisHeading } from '../../src/lib/analysis/additions.server.ts';
import { VIEWS } from '../../src/lib/components/view-registry.ts';

afterEach(() => vi.unstubAllEnvs());

describe('analysis additions pending client approval (GRS-48)', () => {
	it.each([undefined, '', '0', 'false', 'true', 'yes'])('keeps additions off for %j', (value) => {
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', value);
		expect(analysisAdditionsEnabled()).toBe(false);
	});
	it('requires the explicit opt-in value 1', () => {
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', '1');
		expect(analysisAdditionsEnabled()).toBe(true);
	});
	it.each([
		['timeline', 'Timeline'],
		['vdm_matrix_tab', 'Defence & Rebuttal'],
		['info_required_tab', 'Info Required'],
	] as const)('keeps the original %s heading until opt-in', (view, original) => {
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', undefined);
		expect(analysisHeading(view)).toBe(original);
		vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', '1');
		expect(analysisHeading(view)).toBe(VIEWS.find((v) => v.id === view)?.label);
	});
});

// Captured by running defenceCsv and reading the literal headings in a db73856 worktree; synthetic data only.
import base from './base-db73856.json';
import { defenceCsv } from '../../src/lib/views/analysis/defence.ts';

it.each([undefined, '0', 'false'])('matches the base quoted/multiline export and all headings with flag %j', (flag) => {
 vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', flag);
 expect(defenceCsv(base.keys, base.rows, analysisAdditionsEnabled())).toBe(base.csv);
 expect(defenceCsv(base.keys, base.rows)).toBe(base.csv);
 expect(analysisHeading('timeline')).toBe(base.headings.timeline);
 expect(analysisHeading('vdm_matrix_tab')).toBe(base.headings.vdm_matrix_tab);
 expect(analysisHeading('info_required_tab')).toBe(base.headings.info_required_tab);
});

it.each(['timeline', 'vdm_matrix_tab', 'info_required_tab'] as const)('pins the base %s heading independently of CSV', (view) => {
 vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', '0');
 expect(analysisHeading(view)).toBe(base.headings[view]);
});
