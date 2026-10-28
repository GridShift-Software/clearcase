import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'contradictions_tab'>> = datasetView('contradictions_tab', d => !d.c);
