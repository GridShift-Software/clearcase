import { datasetView } from '$lib/views/hosted/payloads.server';
export const load = datasetView('quantum_tab', (d) => !d.quantum);
