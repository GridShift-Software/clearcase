import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { AUTH_FIELDS, authoritiesMerge, canAddAuthority, type AuthValues } from '$lib/views/litigation/authorities';
import { STORES, addAction, authoritiesPure, formAddId, orderedRows, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const store = app().store;
	const shard = authoritiesPure({ store, vid: version.id, vc: viewContentOf(store, version.id) });
	return authoritiesMerge(shard, { rows: orderedRows(version.caseId, STORES.authorities) }, randomUUID());
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const { caseId } = actionCase(params);
		const f = await request.formData();
		const values = valuesOf(f, AUTH_FIELDS) as AuthValues;
		if (!canAddAuthority(values)) return fail(400, { op: 'add', values, message: null });
		return addAction(caseId, STORES.authorities, values, formAddId(f));
	},
};
