import { datasetView } from '$lib/views/hosted/payloads.server';
export const load = datasetView('invoice_ledger_tab', (d) => d.ledger.length === 0);
