import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisAdditionsEnabled } from '../../src/lib/analysis/additions.server.ts';
import { defenceCsv } from '../../src/lib/views/analysis/defence.ts';
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
		expect(defenceCsv(base.keys, base.rows)).toBe(base.csv);
	});
});
