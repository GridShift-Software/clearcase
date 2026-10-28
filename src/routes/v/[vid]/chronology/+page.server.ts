import { app } from '$lib/local-case/app.server';
import { versionPath } from '$lib/local-case/model';
import { exportFileName, viewContentOf } from '$lib/local-case/results.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return { exportName: exportFileName(viewContentOf(app().store, version.id), 'chronology', 'chronology.csv'), listHref: `/api${versionPath(version.id)}/chronology` };
};
