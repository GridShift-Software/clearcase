import { app } from '$lib/local-case/app.server';
import { content, payments, settlementPure } from '$lib/views/quantum/data.server';
import { settlementMerge } from '$lib/views/quantum/settlement';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return settlementMerge(settlementPure({ store: app().store, vid: version.id, vc: content(version.id) }), { payments: payments(version.caseId) });
};
