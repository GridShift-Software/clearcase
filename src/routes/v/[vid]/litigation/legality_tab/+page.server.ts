import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { cleanName } from '$lib/views/litigation/readonly';
import { knownRefs } from '$lib/views/litigation/register.server';
import type { PageServerLoad } from './$types';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const rows = (v: unknown) => (Array.isArray(v) ? v : []).map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {}));

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<Record<string, unknown>>(a.store, version.id, 'lit-legality');
	const L = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
	const docs = rows(L?.docs).map((d) => ({ ref: s(d.ref), date: s(d.date), title: cleanName(d.title) }));
	const scenarios = rows(L?.scenarios).map((x) => ({ scenario: s(x.scenario), effect: s(x.effect), prob: s(x.prob), action: s(x.action) }));
	const factors = rows(L?.factors).map((x) => ({ factor: s(x.factor), note: s(x.note) }));
	const intro = s(L?.intro);
	// documents are linked by ref against the version (a missing ref renders broken, never fuzzy-matched)
	const vc = viewContentOf(a.store, version.id);
	const exists = [...resolveRefs(a.store, version.id, docs.map((d) => d.ref).filter(Boolean))];
	return {
		present: L !== null, intro, docs, scenarios, factors, exists,
		subtitle: viewText(vc, 'legality_tab', 'subtitle'),
		// v5's case wording for the docs caption and the scenario action heading (view-content), else the neutral wording
		docsHeading: viewText(vc, 'legality_tab', 'docsHeading', { count: docs.length }) ?? `Documents in the bundle (${docs.length})`,
		actionHeading: viewText(vc, 'legality_tab', 'scenarioActionHeading') ?? 'Action',
		known: knownRefs(version.id, [intro, ...scenarios.flatMap((x) => [x.effect, x.action]), ...factors.map((x) => x.note)]),
	};
};
