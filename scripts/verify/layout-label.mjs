// The label check and the child-server env of scripts/verify/layout.mjs (BA-18, GRS-48), kept apart so tests/gate can cover them.
// The heading expected on a view depends on CLEARCASE_ANALYSIS_ADDITIONS (ADR 0003): off by default, then Timeline, Defence & Rebuttal
// and Info Required keep v5's heading. The run selects the state explicitly, records it, and launches the app with that same state.
import { viewHeading } from '../../src/lib/views/analysis/headings.ts';

export const analysisAdditionsFrom = (env) => env.CLEARCASE_ANALYSIS_ADDITIONS === '1';

/** @param {{ id: string, label: string }} v @param {{ heading: string | null, title: string, nav: string | null }} id @param {boolean} additions */
export const labelCheck = (v, id, additions) => {
	const expected = viewHeading(v, additions);
	return { expected, ok: id.heading === expected && id.title.startsWith(v.label) && (id.nav ?? '').startsWith(v.label) };
};

/** Env of the launched app: the flag is always set, so the child never inherits a state the run did not record. */
export const serverEnv = (additions) => ({ CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z', TZ: 'UTC', CLEARCASE_ANALYSIS_ADDITIONS: additions ? '1' : '0' });
