import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'entity_ledger_tab'>> = datasetView('entity_ledger_tab', d => !d.entities?.length);
