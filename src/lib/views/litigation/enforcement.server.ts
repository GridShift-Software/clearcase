import { createHash } from 'node:crypto';
import { canonicalJson } from '../../case-package/canonical.ts';
import { datasetOf, viewText } from '../../local-case/results.server.ts';
import type { PureInput } from '../payloads/views.ts';
import { enforcementRows, phasesOf } from './enforcement.ts';
import { knownRefs } from './register.server.ts';

export const stepKey = (s: { phase: string; step: string }) => createHash('sha256').update(canonicalJson({ phase: s.phase, step: s.step })).digest('hex');

/** The Enforcement Roadmap without the saved statuses (ticket 04): what the operator machine builds into the shard. */
export function enforcementPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<unknown[]>(store, vid, 'lit-enforcement');
	const rows = enforcementRows(Array.isArray(raw) ? raw : [], stepKey, new Map());
	const content = { subtitle: viewText(vc, 'enforcement_tab', 'subtitle'), why: viewText(vc, 'enforcement_tab', 'whyNarrative') };
	return { present: Array.isArray(raw), rows, phases: phasesOf(rows), content, known: knownRefs(vid, [content.why, ...rows.flatMap((r) => [r.basis, r.note])], store) };
}
