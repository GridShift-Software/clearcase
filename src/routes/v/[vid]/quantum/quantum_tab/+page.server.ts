import { exportFileName, viewText } from '$lib/local-case/results.server';
import { content, dataset, resolvableRefs, type Quantum } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const q = dataset<Quantum>(version.id, 'quantum');
	const vc = content(version.id);
	const cited = q ? [q.headline_ref, ...q.amountDueSeries.map((s) => s.ref), ...q.invoiceLedger.map((r) => r.ref)] : [];
	const known = resolvableRefs(version.id, cited);
	return {
		quantum: q,
		content: { subtitle: viewText(vc, 'quantum_tab', 'subtitle'), kpiLatestNote: viewText(vc, 'quantum_tab', 'kpiLatestNote'), kpiInvoicesNote: viewText(vc, 'quantum_tab', 'kpiInvoicesNote') },
		exportName: exportFileName(vc, 'quantum_tab', 'invoices.csv'),
		known: [...new Set(cited)].filter((r) => known.has(r)),
	};
};
