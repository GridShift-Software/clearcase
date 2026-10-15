import { app } from '$lib/local-case/app.server';
import { datasetOf, exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import type { ContractsData } from '$lib/views/evidence/contracts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const c = datasetOf<ContractsData>(a.store, version.id, 'contracts');
	const docs = evidenceRows(a.store, version.id);
	const vc = viewContentOf(a.store, version.id);
	const t = (f: string) => viewText(vc, 'contracts_tab', f);
	return {
		contracts: c,
		files: [...new Set((c?.groups ?? []).flatMap((g) => g.items.map((x) => x.ref)))].map((ref) => [ref, docs?.byRef.get(ref)?.file ?? null] as const),
		// case wording v5 hard-coded in its renderer (S-contracts_tab-2), imported as view-content
		exportName: exportFileName(vc, 'contracts_tab', 'contracts.csv'),
		content: { subtitle: t('subtitle'), spineValue: t('kpiSpineValue'), spineNote: t('kpiSpineNote'), watchValue: t('kpiWatchValue'), watchNote: t('kpiWatchNote'), counselNote: t('counselNote') },
	};
};
