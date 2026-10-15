import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { elementColumns, elementTarget } from '$lib/views/litigation/readonly';
import { knownRefs } from '$lib/views/litigation/register.server';
import type { PageServerLoad } from './$types';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<unknown[]>(a.store, version.id, 'lit-elements');
	const elements = (Array.isArray(raw) ? raw : []).map((r) => {
		const e = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
		return { element: s(e.element), must: s(e.must), evidence: s(e.evidence), witness: s(e.witness), tab: s(e.tab), target: elementTarget(e.tab)?.id ?? null };
	});
	const vc = viewContentOf(a.store, version.id);
	return {
		present: Array.isArray(raw), elements,
		subtitle: viewText(vc, 'elements_tab', 'subtitle'),
		columns: elementColumns(vc.list('elements_tab', 'columns')),
		known: knownRefs(version.id, elements.flatMap((e) => [e.must, e.evidence])),
	};
};
