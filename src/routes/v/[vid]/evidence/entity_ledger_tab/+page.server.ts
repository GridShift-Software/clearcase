import { app } from '$lib/local-case/app.server';
import { datasetOf } from '$lib/local-case/results.server';
import { entities } from '$lib/views/evidence/people';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return { entities: entities(datasetOf(app().store, version.id, 'entities')) };
};
