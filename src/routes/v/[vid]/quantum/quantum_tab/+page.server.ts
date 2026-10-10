import { viewText } from '$lib/local-case/results.server';
import { content, dataset, resolvableRefs, type Quantum } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const q = dataset<Quantum>(version.id, 'quantum');
	const vc = content(version.id);
	const known = resolvableRefs(version.id);
	const cited = q ? [q.headline_ref, ...q.amountDueSeries.map((s) => s.ref), ...q.invoiceLedger.map((r) => r.ref)] : [];
	return {
		quantum: q,
		// case wording v5 hard-coded in this renderer, imported as view-content (GRS-38)
		content: { subtitle: viewText(vc, 'quantum_tab', 'subtitle'), kpiLatestNote: viewText(vc, 'quantum_tab', 'kpiLatestNote'), kpiInvoicesNote: viewText(vc, 'quantum_tab', 'kpiInvoicesNote') },
		known: [...new Set(cited)].filter((r) => known.has(r)),
	};
};
