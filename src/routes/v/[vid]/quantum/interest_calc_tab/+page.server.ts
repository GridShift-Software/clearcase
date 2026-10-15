import { citedRefs } from '$lib/components/cite';
import { content, dataset, resolvableRefs, type InterestBasis } from '$lib/views/quantum/data.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const basis = dataset<InterestBasis>(version.id, 'lit-interest-basis');
	const note = basis?.note || null;
	return {
		defaults: { rate: content(version.id).number('interest_calc_tab', 'defaultRate'), from: basis ? basis.first_invoice_date || basis.award_date : '', to: basis?.headline_date ?? '' },
		headlineDue: basis?.headline_due ?? '',
		note,
		known: note ? [...resolvableRefs(version.id, citedRefs([note]))] : [],
	};
};
