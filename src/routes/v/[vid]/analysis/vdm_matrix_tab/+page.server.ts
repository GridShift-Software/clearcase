import { analysisAdditionsEnabled, analysisDataset, existingOf } from '$lib/analysis/data.server';
import { app } from '$lib/local-case/app.server';
import { viewById } from '$lib/components/views';
import { EXPORT_COLUMNS_NOTE, exportColumns, exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { DEFENCE_CSV_NAME, NEUTRAL_CSV_KEYS, defenceCsvKeys, defenceHeadings, type DefenceRow } from '$lib/views/analysis/defence';
import { viewHeading } from '$lib/views/analysis/headings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const rows = (analysisDataset<DefenceRow[]>(version.id, 'defence-matrix') ?? []).map((r) => ({ point: r.point, dcs: r.dcs, evidence: r.evidence, rebuttal: r.rebuttal, refs: r.refs, docs: r.docs.map((d) => ({ ref: d.ref })) }));
	const vc = viewContentOf(app().store, version.id);
	const additions = analysisAdditionsEnabled();
	return {
		heading: viewHeading(viewById('vdm_matrix_tab')!, additions),
		rows,
		subtitle: viewText(vc, 'vdm_matrix_tab', 'subtitle'),
		headings: [...defenceHeadings(vc.list('vdm_matrix_tab', 'columns'))],
		exportName: exportFileName(vc, 'vdm_matrix_tab', DEFENCE_CSV_NAME),
		exportColumns: defenceCsvKeys(exportColumns(vc, 'vdm_matrix_tab', NEUTRAL_CSV_KEYS), EXPORT_COLUMNS_NOTE, additions),
		known: existingOf(version.id, rows.flatMap((r) => r.docs.map((d) => d.ref))),
		analysisAdditions: additions,
	};
};
