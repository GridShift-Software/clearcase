import { fail, redirect } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { slotStates } from '$lib/local-case/overview-widgets.server';
import { versionPath } from '$lib/local-case/model';
import { overviewMerge } from '$lib/views/overview/merge';
import { overviewPure } from '$lib/views/overview/pure.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version, isActive } = await parent();
	const a = app();
	const shard = overviewPure({ store: a.store, vid: version.id, vc: viewContentOf(a.store, version.id) });
	return overviewMerge(shard, {
		notes: a.userWork.summary(version.caseId, version.id),
		previous: isActive ? a.previousVersion(version.caseId) : null,
		slots: await slotStates({ app: a, caseId: version.caseId, caseName: version.caseName, resultsVersion: version.id }),
	});
};

export const actions: Actions = {
	rollback: async ({ params, request }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const str = (k: string) => { const x = f.get(k); return typeof x === 'string' && x ? x : null; };
		const refused = await a.rollback(v.case_id, str('expect'), str('to'));
		if (refused) return fail(refused.message.startsWith('Nothing was changed') ? 409 : 400, { message: refused.message });
		const now = a.effectiveActive(v.case_id);
		redirect(303, now ? `${versionPath(now)}/overview` : '/cases');
	},
};
