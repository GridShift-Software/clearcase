import { error } from '@sveltejs/kit';
import { viewAt } from '$lib/components/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const view = viewAt(params.category, params.view);
	if (!view) error(404, 'Unknown view');
	return { view };
};
