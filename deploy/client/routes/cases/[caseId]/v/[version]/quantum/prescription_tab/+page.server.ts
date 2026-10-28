import { datasetView } from '$lib/views/hosted/payloads.server';
import type { ViewShards } from '$lib/views/payloads/views';
import { saDate } from '$lib/calculations/dates';
export const load = datasetView('prescription_tab', (d) => d.rows.length === 0 && !d.summary, {
  post: (props: ViewShards['prescription_tab'], { now }: { now: () => Date }) => ({ ...props, asOf: saDate(now()) }),
});
