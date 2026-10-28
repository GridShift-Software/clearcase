import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { CX_FIELDS, CX_SEED as SEED, canAddCx, crossexamMerge, type CxValues } from '$lib/views/litigation/crossexam';
import { registers } from '$lib/local-case/registers.server';
import { STORES, addAction, crossexamPure, deleteAnswer, deleteTarget, field, formAddId, orderedRows, register, unconfirmed, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const shard = crossexamPure({ store: a.store, vid: version.id, vc: viewContentOf(a.store, version.id) });
	const seeds = registers(a.userWork).seeds(version.caseId, version.id, SEED).views();
	return crossexamMerge(shard, { seeds, rows: orderedRows(version.caseId, STORES.crossexam) }, randomUUID());
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const { caseId } = actionCase(params);
		const f = await request.formData();
		const values = valuesOf(f, CX_FIELDS) as CxValues;
		if (!canAddCx(values)) return fail(400, { op: 'add', values, message: null });
		return addAction(caseId, STORES.crossexam, values, formAddId(f));
	},
	delete: async ({ params, request }) => {
		const { vid, caseId } = actionCase(params);
		const f = await request.formData();
		const values = valuesOf(f, CX_FIELDS);
		const row = field(f, 'rowId');
		const refused = unconfirmed(f, row || field(f, 'seedId'), values);
		if (refused) return refused;
		if (row) {
			const { id, version } = deleteTarget(row);
			return deleteAnswer(id, values, () => register(caseId, STORES.crossexam).remove(id, version));
		}
		const { id, version } = deleteTarget(field(f, 'seedId'));
		return deleteAnswer(id, values, () => registers(app().userWork).seeds(caseId, vid, SEED).remove(id, version));
	},
};
