import { citedRefs } from '$lib/components/cite';
import { now } from '$lib/components/clock';
import { app } from '$lib/local-case/app.server';
import { utcDate } from '$lib/calculations/dates';
import { dataset, resolvableRefs, type InterestBasis, type PrescriptionRow, type PrescSummary } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const rows = dataset<PrescriptionRow[]>(version.id, 'lit-prescription') ?? [];
	const summary = dataset<PrescSummary>(version.id, 'lit-presc-summary');
	const known = resolvableRefs(version.id);
	const note = summary?.note || null;
	return {
		rows,
		summary,
		// v5's labels were classified against this date when the package was built (S-prescription-frozen)
		headlineDate: dataset<InterestBasis>(version.id, 'lit-interest-basis')?.headline_date ?? '',
		// BA-01: the explicit as-of date, the calendar date of now() in UTC
		asOf: utcDate(now()),
		known: [...new Set(rows.map((r) => r.ref))].filter((r) => known.has(r)),
		note,
		noteKnown: note ? [...app().store.existingRefs(version.id, citedRefs([note]))] : [],
	};
};
