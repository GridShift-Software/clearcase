import { exportFileName, viewText } from '$lib/local-case/results.server';
import { content, dataset, resolvableRefs, type Quantum } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const ledger = dataset<Quantum>(version.id, 'quantum')?.invoiceLedger ?? [];
	const known = resolvableRefs(version.id, ledger.map((r) => r.ref));
	return {
		ledger,
		// the subtitle is case wording from view-content; its count is the imported ledger's length
		subtitle: viewText(content(version.id), 'invoice_ledger_tab', 'subtitle', { count: ledger.length }),
		exportName: exportFileName(content(version.id), 'invoice_ledger_tab', 'invoices.csv'),
		known: [...new Set(ledger.map((r) => r.ref))].filter((r) => known.has(r)),
	};
};
