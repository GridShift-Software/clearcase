import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { enforcementRows, phasesOf, statusOptions } from '$lib/views/litigation/enforcement';
import { stepKey } from '$lib/views/litigation/enforcement.server';
import { STORES, field, guarded, knownRefs, nextSeq, orderedRows, serialized, text } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

/** The case's saved statuses by step key (one row per key; the latest by seq wins if a key repeats). */
function overrides(caseId: string) {
	const out = new Map<string, { rowId: string; status: string; seq: number | null }>();
	for (const r of orderedRows(caseId, STORES.enforcement)) {
		const k = text(r.fields.stepKey), s = text(r.fields.status);
		if (k && s) out.set(k, { rowId: r.rowId, status: s, seq: typeof r.fields.seq === 'number' ? r.fields.seq : null });
	}
	return out;
}

const rowsOf = (rv: string, caseId: string) => {
	const raw = datasetOf<unknown[]>(app().store, rv, 'lit-enforcement');
	const saved = overrides(caseId);
	return { present: Array.isArray(raw), rows: enforcementRows(Array.isArray(raw) ? raw : [], stepKey, new Map([...saved].map(([k, v]) => [k, v.status]))), saved };
};

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const vc = viewContentOf(app().store, version.id);
	const { present, rows } = rowsOf(version.id, version.caseId);
	const content = { subtitle: viewText(vc, 'enforcement_tab', 'subtitle'), why: viewText(vc, 'enforcement_tab', 'whyNarrative') };
	return { present, rows, phases: phasesOf(rows), content, known: knownRefs(version.id, [content.why, ...rows.flatMap((r) => [r.basis, r.note])]) };
};

export const actions: Actions = {
	status: async ({ params, request }) => {
		const v = app().store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = { stepKey: field(f, 'stepKey'), status: field(f, 'status') };
		const { rows } = rowsOf(v.id, v.case_id);
		const row = rows.find((r) => r.key !== null && r.key === values.stepKey);
		if (!row) return fail(404, { values, message: 'Not saved: that step is not in this results version, or it is not unique.' });
		if (!statusOptions(row.status).includes(values.status)) return fail(400, { values, message: 'Not saved: choose one of the listed statuses.' });
		// one row per step key: a change replaces that row's fields (keeping its seq), a first change inserts one; the
		// existing row is looked up inside the serialized section, so two changes never insert two rows for one key
		const r = await guarded(values, () => serialized(`${v.case_id}\u0000${STORES.enforcement}`, async () => {
			const prior = overrides(v.case_id).get(values.stepKey);
			const seq = prior?.seq ?? nextSeq(orderedRows(v.case_id, STORES.enforcement));
			return app().userWork.putRow(v.case_id, STORES.enforcement, prior?.rowId ?? null, { stepKey: values.stepKey, status: values.status, seq });
		}));
		return r.ok ? { saved: values.stepKey } : r.failure;
	},
};
