import { app } from '$lib/local-case/app.server';
import { content, interestPure, payments } from '$lib/views/quantum/data.server';
import { interestMerge } from '$lib/views/quantum/interest';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return interestMerge(interestPure({ store: app().store, vid: version.id, vc: content(version.id) }), { payments: payments(version.caseId) });
};
