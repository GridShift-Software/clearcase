import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'people'>> = datasetView('people', d => !d.people?.length);
