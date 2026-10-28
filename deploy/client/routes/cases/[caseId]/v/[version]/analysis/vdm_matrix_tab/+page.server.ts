import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'vdm_matrix_tab'>> = datasetView('vdm_matrix_tab', d => !d.rows.length);
