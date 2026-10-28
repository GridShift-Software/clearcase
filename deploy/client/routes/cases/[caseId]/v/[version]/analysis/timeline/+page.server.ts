import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'timeline'>> = datasetView('timeline', d => !d.phases.some(p => p.events.length) && !d.unplaced.length && !d.content.narrative);
