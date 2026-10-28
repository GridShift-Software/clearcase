import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'conflict_tab'>> = datasetView('conflict_tab', d => !d.people.length && !d.entities.length);
