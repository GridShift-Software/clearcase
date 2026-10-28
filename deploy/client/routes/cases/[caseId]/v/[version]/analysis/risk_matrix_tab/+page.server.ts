import { datasetView } from '$lib/views/hosted/payloads.server';
export const load: ReturnType<typeof datasetView<'risk_matrix_tab'>> = datasetView('risk_matrix_tab', d => !d.risks.length);
