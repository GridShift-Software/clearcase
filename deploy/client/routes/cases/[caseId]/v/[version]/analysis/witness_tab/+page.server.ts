import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'witness_tab'>> = datasetView('witness_tab', d => !d.witnesses.length);
