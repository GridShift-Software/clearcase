import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { documentRows } from '$lib/local-case/documents.server';
import { exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { HEADS_FIELDS, HEADS_FILE, canAddHead, evidenceTokens, type HeadsValues } from '$lib/views/litigation/heads';
import { STORES, addAction, deleteAnswer, deleteTarget, deleteValue, field, formAddId, orderedRows, register, text, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const vc = viewContentOf(a.store, version.id);
	const saved = orderedRows(version.caseId, STORES.heads);
	// evidence refs resolve against every document row of the version, provider (rescan) rows included
	const docs = saved.some((r) => text(r.fields.ref)) ? new Set(documentRows(a.store, version.id).rows.map((d) => d.ref)) : new Set<string>();
	return {
		rows: saved.map((r) => {
			const v = Object.fromEntries(HEADS_FIELDS.map((k) => [k, text(r.fields[k])])) as HeadsValues;
			return { rowId: r.rowId, del: deleteValue(r.rowId, r.version), ...v, evidence: evidenceTokens(v.ref, (t) => docs.has(t)) };
		}),
		caption: viewText(vc, 'heads_tab', 'exportCaption'),
		// the export's file name is case content (GRS-38): the package's view-content field, else the neutral name and a note
		exportName: exportFileName(vc, 'heads_tab', HEADS_FILE),
		addId: randomUUID(),
	};
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const { caseId } = actionCase(params);
		const f = await request.formData();
		const values = valuesOf(f, HEADS_FIELDS) as HeadsValues;
		if (!canAddHead(values)) return fail(400, { op: 'add', values, message: null });
		return addAction(caseId, STORES.heads, values, formAddId(f));
	},
	// a row's Delete submits the add form (formaction), so the typed entry travels with it and comes back in the answer
	delete: async ({ params, request }) => {
		const { caseId } = actionCase(params);
		const f = await request.formData();
		const { id, version } = deleteTarget(field(f, 'rowId'));
		return deleteAnswer(id, valuesOf(f, HEADS_FIELDS), () => register(caseId, STORES.heads).remove(id, version));
	},
};
