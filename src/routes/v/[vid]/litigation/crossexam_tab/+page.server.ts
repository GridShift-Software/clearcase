import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { CX_FIELDS, canAddCx, crossexamRows, type CxValues } from '$lib/views/litigation/crossexam';
import { STORES, addAction, deleteAnswer, deleteRowChecked, deleteTarget, deleteValue, field, formAddId, knownRefs, orderedRows, rowVersion, valuesOf } from '$lib/views/litigation/register.server';
import { deleteSeed, seedVersion } from '$lib/views/litigation/writes.server';
import type { Actions, PageServerLoad } from './$types';

const SEED = 'lit-crossexam-seed';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const views = a.userWork.seedViews(version.caseId, version.id, SEED);
	const user = orderedRows(version.caseId, STORES.crossexam);
	const seedVersions = new Map(views.map((x) => [x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId, seedVersion(x)]));
	const rowVersions = new Map(user.map((r) => [r.rowId, rowVersion(r)]));
	// each row's Delete value names its target and the version of what the page shows (re-checked when it is deleted)
	const rows = crossexamRows(views, user).map((r) => ({ ...r, del: 'rowId' in r.target ? deleteValue(r.target.rowId, rowVersions.get(r.target.rowId)!) : deleteValue(r.target.seedId, seedVersions.get(r.target.seedId)!) }));
	return {
		rows,
		tip: viewText(viewContentOf(a.store, version.id), 'crossexam_tab', 'tip'),
		known: knownRefs(version.id, rows.filter((r) => r.authored).map((r) => r.put)),
		addId: randomUUID(),
	};
};

const versionOf = (vid: string) => app().store.getVersion(vid);

export const actions: Actions = {
	add: async ({ params, request }) => {
		const v = versionOf(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = valuesOf(f, CX_FIELDS) as CxValues;
		if (!canAddCx(values)) return fail(400, { op: 'add', values, message: null });
		return addAction(v.case_id, STORES.crossexam, values, formAddId(f));
	},
	// a row's Delete submits the add form (formaction), so the typed entry travels with it and comes back in the answer
	delete: async ({ params, request }) => {
		const v = versionOf(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = valuesOf(f, CX_FIELDS);
		const row = field(f, 'rowId');
		if (row) {
			const { id, version } = deleteTarget(row);
			return deleteAnswer(id, values, () => deleteRowChecked(v.case_id, STORES.crossexam, id, version));
		}
		// a seed is never removed from results: the user's deletion is an overlay on it, made against its current content
		const { id, version } = deleteTarget(field(f, 'seedId'));
		return deleteAnswer(id, values, () => deleteSeed(app().userWork, v.case_id, v.id, SEED, id, version));
	},
};
