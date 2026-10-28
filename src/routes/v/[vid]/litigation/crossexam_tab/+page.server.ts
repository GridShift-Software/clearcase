import { randomUUID } from 'node:crypto';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { crossexamActions } from '$lib/views/litigation/actions.server';
import { CX_SEED as SEED, crossexamMerge } from '$lib/views/litigation/crossexam';
import { registers } from '$lib/local-case/registers.server';
import { STORES, crossexamPure, localCtx, orderedRows } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const shard = crossexamPure({ store: a.store, vid: version.id, vc: viewContentOf(a.store, version.id) });
	const seeds = registers(a.userWork).seeds(version.caseId, version.id, SEED).views();
	return crossexamMerge(shard, { seeds, rows: orderedRows(version.caseId, STORES.crossexam) }, randomUUID());
};

export const actions: Actions = crossexamActions(localCtx);
