import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'quantum_tab'>> = datasetView('quantum_tab', (d) => !d.quantum);
