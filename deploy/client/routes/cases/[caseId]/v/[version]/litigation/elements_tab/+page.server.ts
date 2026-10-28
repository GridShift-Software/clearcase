import { datasetView } from '$lib/views/hosted/payloads.server';
export const load = datasetView('elements_tab', (d) => d.elements.length === 0);
