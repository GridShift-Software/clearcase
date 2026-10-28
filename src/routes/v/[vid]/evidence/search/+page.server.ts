import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { exportFileName, viewContentOf } from '$lib/local-case/results.server';
import { searchRowsOf } from '$lib/views/evidence/rows.server';
import { searchPage } from '$lib/views/evidence/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const sr = searchRowsOf(app().store, version.id);
	if (!sr) error(404, 'Unknown results version');
	return {
		...searchPage(sr.rows, url.searchParams),
		failed: sr.failed,
		exportName: exportFileName(viewContentOf(app().store, version.id), 'search', 'search.csv'),
	};
};
