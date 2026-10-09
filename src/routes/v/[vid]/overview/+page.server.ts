import { fail, redirect } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { app } from '$lib/local-case/app.server';
import { slotStates } from '$lib/local-case/overview-widgets.server';
import { versionPath, type OverviewModel } from '$lib/local-case/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version, isActive } = await parent();
	const a = app();
	const v = a.store.getVersion(version.id)!;
	const overview = JSON.parse(v.overview) as OverviewModel;
	const narrative = overview.matter?.storyline[0]?.t ?? null;
	return {
		overview,
		narrative,
		known: narrative ? [...a.store.existingRefs(v.id, citedRefs([narrative]))] : [],
		notes: a.userWork.summary(v.case_id, v.id),
		previous: isActive ? a.previousVersion(v.case_id) : null,
		slots: await slotStates({ app: a, caseId: v.case_id, caseName: version.caseName, resultsVersion: v.id }),
	};
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
		redirect(303, '/');
	},
};
