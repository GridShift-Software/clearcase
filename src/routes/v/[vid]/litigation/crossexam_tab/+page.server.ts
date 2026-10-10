import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { CX_FIELDS, canAddCx, crossexamRows, type CxValues } from '$lib/views/litigation/crossexam';
import { STORES, addRow, field, guarded, knownRefs, orderedRows } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

const SEED = 'lit-crossexam-seed';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const rows = crossexamRows(a.userWork.seedViews(version.caseId, version.id, SEED), orderedRows(version.caseId, STORES.crossexam));
	return {
		rows,
		tip: viewText(viewContentOf(a.store, version.id), 'crossexam_tab', 'tip'),
		known: knownRefs(version.id, rows.filter((r) => r.authored).map((r) => r.put)),
	};
};

const versionOf = (vid: string) => app().store.getVersion(vid);

export const actions: Actions = {
	add: async ({ params, request }) => {
		const v = versionOf(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = Object.fromEntries(CX_FIELDS.map((k) => [k, field(f, k)])) as CxValues;
		if (!canAddCx(values)) return fail(400, { values, message: null });
		const r = await guarded(values, () => addRow(v.case_id, STORES.crossexam, values));
		return r.ok ? { added: r.value } : r.failure;
	},
	delete: async ({ params, request }) => {
		const v = versionOf(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const rowId = field(f, 'rowId'), seedId = field(f, 'seedId');
		const a = app();
		if (rowId) {
			const r = await guarded({}, () => a.userWork.deleteRow(v.case_id, STORES.crossexam, rowId));
			return r.ok ? { deleted: rowId } : r.failure;
		}
		// a seed is never removed from results: the user's deletion is an overlay on it, made against its current content
		const views = a.userWork.seedViews(v.case_id, v.id, SEED);
		const sv = views.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId);
		if (!sv) return fail(404, { message: 'That topic is not in this results version.' });
		const base = sv.state === 'orphaned' ? sv.overlay.baseSeedSha256 : sv.seed.seedSha256;
		const r = await guarded({}, () => a.userWork.putSeedOverlay({ caseId: v.case_id, datasetKey: SEED, seedId, baseSeedSha256: base, fields: { deleted: true } }));
		return r.ok ? { deleted: seedId } : r.failure;
	},
};
