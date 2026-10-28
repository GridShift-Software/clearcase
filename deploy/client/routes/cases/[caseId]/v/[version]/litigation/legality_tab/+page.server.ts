import { datasetView } from '$lib/views/hosted/payloads.server';
export const load = datasetView('legality_tab', (d) => !d.intro && !d.docs.length && !d.scenarios.length && !d.factors.length);
