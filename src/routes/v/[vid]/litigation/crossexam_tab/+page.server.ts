import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { CX_FIELDS, canAddCx, crossexamRows, type CxValues } from '$lib/views/litigation/crossexam';
import { registers } from '$lib/local-case/registers.server';
import { STORES, addAction, deleteAnswer, deleteTarget, deleteValue, field, formAddId, knownRefs, orderedRows, register, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

const SEED = 'lit-crossexam-seed';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const views = registers(a.userWork).seeds(version.caseId, version.id, SEED).views();
	const user = orderedRows(version.caseId, STORES.crossexam);
	const seedVersions = new Map(views.map((x) => [x.seedId, x.version]));
	const rowVersions = new Map(user.map((r) => [r.rowId, r.version]));
	const rows = crossexamRows(views, user).map((r) => ({ ...r, del: 'rowId' in r.target ? deleteValue(r.target.rowId, rowVersions.get(r.target.rowId)!) : deleteValue(r.target.seedId, seedVersions.get(r.target.seedId)!) }));
	return {
		rows,
		tip: viewText(viewContentOf(a.store, version.id), 'crossexam_tab', 'tip'),
		known: knownRefs(version.id, rows.filter((r) => r.authored).map((r) => r.put)),
		addId: randomUUID(),
	};
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
		if (row) {
			const { id, version } = deleteTarget(row);
			return deleteAnswer(id, values, () => register(caseId, STORES.crossexam).remove(id, version));
		}
		const { id, version } = deleteTarget(field(f, 'seedId'));
		return deleteAnswer(id, values, () => registers(app().userWork).seeds(caseId, vid, SEED).remove(id, version));
	},
};
