import { citedRefs } from '$lib/components/cite';
import { now } from '$lib/components/clock';
import { exportFileName } from '$lib/local-case/results.server';
import { saDate } from '$lib/calculations/dates';
import { content, dataset, resolvableRefs, type InterestBasis, type PrescriptionRow, type PrescSummary } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const rows = dataset<PrescriptionRow[]>(version.id, 'lit-prescription') ?? [];
	const summary = dataset<PrescSummary>(version.id, 'lit-presc-summary');
	const known = resolvableRefs(version.id, rows.map((r) => r.ref));
	const note = summary?.note || null;
	return {
		rows,
		summary,
		headlineDate: dataset<InterestBasis>(version.id, 'lit-interest-basis')?.headline_date ?? '',
		asOf: saDate(now()),
		known: [...new Set(rows.map((r) => r.ref))].filter((r) => known.has(r)),
		note,
		exportName: exportFileName(content(version.id), 'prescription_tab', 'prescription.csv'),
		noteKnown: note ? [...resolvableRefs(version.id, citedRefs([note]))] : [],
	};
};
