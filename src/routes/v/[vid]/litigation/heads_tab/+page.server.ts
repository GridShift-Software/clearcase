import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { documentRows } from '$lib/local-case/documents.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { HEADS_FIELDS, canAddHead, evidenceTokens, type HeadsValues } from '$lib/views/litigation/heads';
import { STORES, addRow, field, guarded, orderedRows, text } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const saved = orderedRows(version.caseId, STORES.heads);
	// evidence refs resolve against every document row of the version, provider (rescan) rows included
	const docs = saved.some((r) => text(r.fields.ref)) ? new Set(documentRows(a.store, version.id).rows.map((d) => d.ref)) : new Set<string>();
	return {
		rows: saved.map((r) => {
			const v = Object.fromEntries(HEADS_FIELDS.map((k) => [k, text(r.fields[k])])) as HeadsValues;
			return { rowId: r.rowId, ...v, evidence: evidenceTokens(v.ref, (t) => docs.has(t)) };
		}),
		caption: viewText(viewContentOf(a.store, version.id), 'heads_tab', 'exportCaption'),
	};
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const v = app().store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = Object.fromEntries(HEADS_FIELDS.map((k) => [k, field(f, k)])) as HeadsValues;
		if (!canAddHead(values)) return fail(400, { values, message: null });
		const r = await guarded(values, () => addRow(v.case_id, STORES.heads, values));
		return r.ok ? { added: r.value } : r.failure;
	},
	delete: async ({ params, request }) => {
		const v = app().store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const rowId = field(await request.formData(), 'rowId');
		const r = await guarded({}, () => app().userWork.deleteRow(v.case_id, STORES.heads, rowId));
		return r.ok ? { deleted: rowId } : r.failure;
	},
};
