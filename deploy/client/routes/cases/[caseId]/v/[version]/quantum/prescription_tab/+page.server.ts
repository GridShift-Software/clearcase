import { datasetView } from '$lib/views/hosted/payloads.server';
import { saDate } from '$lib/calculations/dates';
export const load: ReturnType<typeof datasetView<'prescription_tab'>> = datasetView('prescription_tab', (d) => d.rows.length === 0 && !d.summary, {
  post: (props, { now }) => ({ ...props, asOf: saDate(now) }),
});
