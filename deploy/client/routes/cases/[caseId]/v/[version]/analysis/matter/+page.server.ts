import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'matter'>> = datasetView('matter', d => !d.matter);
