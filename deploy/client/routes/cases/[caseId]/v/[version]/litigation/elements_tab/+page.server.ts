import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'elements_tab'>> = datasetView('elements_tab', (d) => d.elements.length === 0);
