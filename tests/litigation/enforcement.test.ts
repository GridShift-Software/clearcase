// Enforcement Roadmap (GRS-18): statuses are overrides keyed by a digest of {phase, step}, never by array index
// (S-enforcement_tab-1, S-index-keys); an imported status outside ENF_OPTS is its own selected option
// (S-enforcement_tab-2, corrected); a duplicate {phase, step} is disclosed and gets no status.
import { describe, expect, it } from 'vitest';
import { ENF_OPTS, allowedStatus, enforcementRows, mapV5EnfStatus, phasesOf, shownStatus, statusOptions } from '../../src/lib/views/litigation/enforcement.ts';
import { stepKey } from '../../src/lib/views/litigation/enforcement.server.ts';

const step = (phase: string, s: string, status = 'To do') => ({ phase, step: s, basis: 'B', status, note: 'N' });

describe('stepKey', () => {
	it('is the sha256 of the canonical {phase, step}, independent of other fields and of position', () => {
		expect(stepKey({ phase: 'P', step: 'S' })).toMatch(/^[0-9a-f]{64}$/);
		expect(stepKey({ phase: 'P', step: 'S' })).toBe(stepKey({ ...step('P', 'S', 'Done'), basis: 'other' } as never));
		expect(stepKey({ phase: 'P', step: 'S' })).not.toBe(stepKey({ phase: 'P', step: 'T' }));
		expect(stepKey({ phase: 'P', step: 'S' })).not.toBe(stepKey({ phase: 'Q', step: 'S' }));
	});
});

describe('enforcementRows', () => {
	it('attaches an override to its step even when the steps are reordered (never by index)', () => {
		const a = step('1', 'A'), b = step('1', 'B');
		const saved = new Map([[stepKey(b), 'Done']]);
		const first = enforcementRows([a, b], stepKey, saved);
		const reordered = enforcementRows([b, a], stepKey, saved);
		expect(first.map((r) => [r.step, shownStatus(r)])).toEqual([['A', 'To do'], ['B', 'Done']]);
		expect(reordered.map((r) => [r.step, shownStatus(r)])).toEqual([['B', 'Done'], ['A', 'To do']]);
		// the imported status stays unchanged under the override
		expect(first[1]).toMatchObject({ status: 'To do', override: 'Done' });
	});

	it('discloses a duplicate {phase, step}: no key and no status for either', () => {
		const rows = enforcementRows([step('1', 'A'), step('1', 'A', 'Done'), step('1', 'B')], stepKey, new Map([[stepKey({ phase: '1', step: 'A' }), 'Monitor']]));
		expect(rows.map((r) => [r.key === null, r.override])).toEqual([[true, null], [true, null], [false, null]]);
	});

	it('reads missing fields as empty text', () => {
		expect(enforcementRows([{ phase: 'P' }], stepKey, new Map())[0]).toMatchObject({ phase: 'P', step: '', status: '', note: '' });
	});
});

describe('statusOptions (S-enforcement_tab-2, corrected; D8)', () => {
	const values = (o: { value: string }[]) => o.map((x) => x.value);
	it('lists ENF_OPTS for a known status', () => {
		expect(values(statusOptions('Contingent'))).toEqual([...ENF_OPTS]);
	});
	it('keeps an imported status outside ENF_OPTS as its own option instead of showing "To do"', () => {
		const opts = values(statusOptions('Awaiting counsel'));
		expect(opts).toEqual([...ENF_OPTS, 'Awaiting counsel']);
		expect(opts.indexOf('Awaiting counsel')).toBeGreaterThan(0);
	});
	it('D8: a saved status outside ENF_OPTS and the imported one stays an option, labelled no longer offered', () => {
		const opts = statusOptions('Done', 'Awaiting counsel');
		expect(values(opts)).toEqual([...ENF_OPTS, 'Awaiting counsel']);
		expect(opts.at(-1)!.label).toBe('Awaiting counsel (no longer offered)');
		expect(values(statusOptions('Awaiting counsel', 'Awaiting counsel'))).toEqual([...ENF_OPTS, 'Awaiting counsel']);
	});
	it('D8: the server accepts re-saving the shown saved status, and nothing outside the options', () => {
		expect(allowedStatus({ status: 'Done', override: 'Awaiting counsel' }, 'Awaiting counsel')).toBe(true);
		expect(allowedStatus({ status: 'Done', override: null }, 'Awaiting counsel')).toBe(false);
		expect(allowedStatus({ status: 'Done', override: 'Monitor' }, 'Done')).toBe(true);
	});
});

describe('phasesOf', () => {
	it('keeps first-appearance order', () => {
		expect(phasesOf([step('2', 'a'), step('1', 'b'), step('2', 'c'), step('3', 'd')])).toEqual(['2', '1', '3']);
	});
});

describe('mapV5EnfStatus (a later import of ess_dcs_enf_status_v1)', () => {
	it('maps an index to the step key of the same results version only', () => {
		const rows = enforcementRows([step('1', 'A'), step('1', 'B')], stepKey, new Map());
		expect(mapV5EnfStatus(rows, { '1': 'Done', '7': 'Done', x: 'Done', '0': '' })).toEqual([{ stepKey: stepKey({ phase: '1', step: 'B' }), status: 'Done' }]);
	});
	it('drops an index that names a duplicate step', () => {
		const rows = enforcementRows([step('1', 'A'), step('1', 'A')], stepKey, new Map());
		expect(mapV5EnfStatus(rows, { '0': 'Done' })).toEqual([]);
	});
});
