import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'invoice_ledger_tab'>> = datasetView('invoice_ledger_tab', (d) => d.ledger.length === 0);
