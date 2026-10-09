import { analysisDataset, existingOf } from '$lib/analysis/data.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { defenceHeadings, type DefenceRow } from '$lib/views/analysis/defence';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const rows = (analysisDataset<DefenceRow[]>(version.id, 'defence-matrix') ?? []).map((r) => ({ point: r.point, dcs: r.dcs, evidence: r.evidence, rebuttal: r.rebuttal, refs: r.refs, docs: r.docs.map((d) => ({ ref: d.ref })) }));
	// The subtitle and column headings name the parties, so they are case content from view-content (GRS-38).
	const vc = viewContentOf(app().store, version.id);
	return {
		rows,
		subtitle: viewText(vc, 'vdm_matrix_tab', 'subtitle'),
		headings: [...defenceHeadings(vc.list('vdm_matrix_tab', 'columns'))],
		known: existingOf(version.id, rows.flatMap((r) => r.docs.map((d) => d.ref))),
	};
};
