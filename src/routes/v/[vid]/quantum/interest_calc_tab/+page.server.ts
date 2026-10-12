import { citedRefs } from '$lib/components/cite';
import { app } from '$lib/local-case/app.server';
import { content, dataset, type InterestBasis } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const basis = dataset<InterestBasis>(version.id, 'lit-interest-basis');
	const note = basis?.note || null;
	return {
		// S-interest_calc_tab-2: the default rate is the package's (view-content); absent, the field stays empty
		defaults: { rate: content(version.id).number('interest_calc_tab', 'defaultRate'), from: basis ? basis.first_invoice_date || basis.award_date : '', to: basis?.headline_date ?? '' },
		headlineDue: basis?.headline_due ?? '',
		note,
		known: note ? [...app().store.existingRefs(version.id, citedRefs([note]))] : [],
	};
};
