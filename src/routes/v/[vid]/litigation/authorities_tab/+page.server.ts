import { randomUUID } from 'node:crypto';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { authoritiesActions } from '$lib/views/litigation/actions.server';
import { authoritiesMerge } from '$lib/views/litigation/authorities';
import { STORES, authoritiesPure, localCtx, orderedRows } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const store = app().store;
	const shard = authoritiesPure({ store, vid: version.id, vc: viewContentOf(store, version.id) });
	return authoritiesMerge(shard, { rows: orderedRows(version.caseId, STORES.authorities) }, randomUUID());
};

export const actions: Actions = authoritiesActions(localCtx);
