import { actionCase, guarded } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { enforcementActions, type EnforcementCtx } from '$lib/views/litigation/actions.server';
import { enforcementMerge } from '$lib/views/litigation/enforcement';
import { enforcementPure } from '$lib/views/litigation/enforcement.server';
import { STORES, localEntries, orderedRows } from '$lib/views/litigation/register.server';
import { saveStatus } from '$lib/views/litigation/writes.server';
import type { Actions, PageServerLoad } from './$types';

const pageOf = (rv: string, caseId: string) => {
	const store = app().store;
	return enforcementMerge(enforcementPure({ store, vid: rv, vc: viewContentOf(store, rv) }), { rows: orderedRows(caseId, STORES.enforcement) });
};

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return pageOf(version.id, version.caseId);
};

const localCtx = ({ params }: { params: Record<string, string | undefined> }): EnforcementCtx => {
	const { vid, caseId } = actionCase(params as { vid: string });
	return {
		caseId, entries: localEntries(caseId, vid), guard: guarded, published: async () => {},
		rows: async () => pageOf(vid, caseId).rows,
		save: (stepKey, status, version) => saveStatus(app().userWork, caseId, STORES.enforcement, stepKey, status, version),
	};
};

export const actions: Actions = enforcementActions(localCtx);
