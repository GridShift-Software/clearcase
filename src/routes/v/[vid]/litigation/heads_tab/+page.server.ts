import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { HEADS_FIELDS, HEADS_FILE, canAddHead, evidenceTokens, splitRefs, type HeadsValues } from '$lib/views/litigation/heads';
import { STORES, addAction, deleteAnswer, deleteTarget, deleteValue, field, formAddId, orderedRows, register, text, unconfirmed, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const vc = viewContentOf(a.store, version.id);
	const saved = orderedRows(version.caseId, STORES.heads);
	const docs = resolveRefs(a.store, version.id, saved.flatMap((r) => splitRefs(text(r.fields.ref))));
	return {
		rows: saved.map((r) => {
			const v = Object.fromEntries(HEADS_FIELDS.map((k) => [k, text(r.fields[k])])) as HeadsValues;
			return { rowId: r.rowId, del: deleteValue(r.rowId, r.version), ...v, evidence: evidenceTokens(v.ref, (t) => docs.has(t)) };
		}),
		caption: viewText(vc, 'heads_tab', 'exportCaption'),
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
	delete: async ({ params, request }) => {
		const { caseId } = actionCase(params);
		const f = await request.formData();
		const raw = field(f, 'rowId'), values = valuesOf(f, HEADS_FIELDS);
		const refused = unconfirmed(f, raw, values);
		if (refused) return refused;
		const { id, version } = deleteTarget(raw);
		return deleteAnswer(id, values, () => register(caseId, STORES.heads).remove(id, version));
	},
};
