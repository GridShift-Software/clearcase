import { datasetView } from '$lib/views/hosted/payloads.server';
export const load = datasetView('contracts_tab', (d) => !(d.contracts?.groups.some((g) => g.items.length)));
