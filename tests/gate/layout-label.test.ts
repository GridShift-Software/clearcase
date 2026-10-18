// scripts/verify/layout.mjs, flag-dependent heading (GRS-48, PR #63 review): the label check follows the explicitly
// selected CLEARCASE_ANALYSIS_ADDITIONS state, and the launched app receives that same state. No case data.
import { describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/lib/components/view-registry';
import { V5_HEADINGS } from '../../src/lib/views/analysis/headings';
import { analysisAdditionsFrom, labelCheck, serverEnv } from '../../scripts/verify/layout-label.mjs';

const page = (v: { label: string }, heading: string | null = v.label) => ({ heading, title: `${v.label} · ClearCase`, nav: v.label });

describe('layout label check', () => {
	it('reads the flag as on only for "1"', () => {
		expect(analysisAdditionsFrom({})).toBe(false);
		expect(analysisAdditionsFrom({ CLEARCASE_ANALYSIS_ADDITIONS: '0' })).toBe(false);
		expect(analysisAdditionsFrom({ CLEARCASE_ANALYSIS_ADDITIONS: 'true' })).toBe(false);
		expect(analysisAdditionsFrom({ CLEARCASE_ANALYSIS_ADDITIONS: '1' })).toBe(true);
	});

	it('flag off: the three views must show v5\'s heading, every other view its label', () => {
		for (const v of VIEWS) {
			const want = V5_HEADINGS[v.id] ?? v.label;
			expect(labelCheck(v, page(v, want), false)).toMatchObject({ ok: true, expected: want });
			if (V5_HEADINGS[v.id]) expect(labelCheck(v, page(v), false).ok, `${v.id} showing the label with the flag off`).toBe(false);
		}
		expect(Object.keys(V5_HEADINGS).sort()).toEqual(['info_required_tab', 'timeline', 'vdm_matrix_tab']);
	});

	it('flag on: every view must show its label; v5\'s heading fails', () => {
		for (const v of VIEWS) {
			expect(labelCheck(v, page(v), true)).toMatchObject({ ok: true, expected: v.label });
			if (V5_HEADINGS[v.id]) expect(labelCheck(v, page(v, V5_HEADINGS[v.id]), true).ok, `${v.id} showing v5's heading with the flag on`).toBe(false);
		}
	});

	it('the navigation entry and the document title always start with the label', () => {
		const v = VIEWS.find((x) => x.id === 'timeline')!;
		for (const on of [false, true]) {
			const heading = on ? v.label : V5_HEADINGS.timeline;
			expect(labelCheck(v, { ...page(v, heading), title: 'Other · ClearCase' }, on).ok).toBe(false);
			expect(labelCheck(v, { ...page(v, heading), nav: 'Other' }, on).ok).toBe(false);
			expect(labelCheck(v, { ...page(v, heading), nav: null }, on).ok).toBe(false);
			expect(labelCheck(v, page(v, null), on).ok).toBe(false);
		}
	});

	it('the child server env carries the recorded flag state, always explicitly', () => {
		expect(serverEnv(false)).toMatchObject({ CLEARCASE_ANALYSIS_ADDITIONS: '0', CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z', TZ: 'UTC' });
		expect(serverEnv(true)).toMatchObject({ CLEARCASE_ANALYSIS_ADDITIONS: '1' });
	});
});
