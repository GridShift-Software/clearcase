import { error } from '@sveltejs/kit';
import { viewAt } from '$lib/components/views';
import type { PageServerLoad } from './$types';

// Extension point for the 40 views the pilot does not own. An owner's own route at
// src/routes/v/[vid]/<category>/<view-id>/ takes precedence over this one; until then the registry entry renders its
// explicit "not yet available" state here. Unknown categories or views are 404.
export const load: PageServerLoad = ({ params }) => {
	const view = viewAt(params.category, params.view);
	if (!view) error(404, 'Unknown view');
	return { view };
};
