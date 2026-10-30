import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'contracts_tab'>> = datasetView('contracts_tab', (d) => !(d.contracts?.groups.some((g) => g.items.length)));
