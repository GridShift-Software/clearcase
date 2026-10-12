import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, exportFileName, viewContentOf } from '$lib/local-case/results.server';
import { AUTH_FIELDS, AUTH_FILE, canAddAuthority, type AuthValues } from '$lib/views/litigation/authorities';
import { STORES, addAction, formAddId, knownRefs, orderedRows, text, valuesOf } from '$lib/views/litigation/register.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const raw = datasetOf<unknown[]>(app().store, version.id, 'lit-authorities');
	const imported = (Array.isArray(raw) ? raw : []).map((r) => {
		const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		return Object.fromEntries(AUTH_FIELDS.map((k) => [k, o[k] === null || o[k] === undefined ? '' : String(o[k])])) as AuthValues;
	});
	const user = orderedRows(version.caseId, STORES.authorities).map((r) => ({ rowId: r.rowId, ...(Object.fromEntries(AUTH_FIELDS.map((k) => [k, text(r.fields[k])])) as AuthValues) }));
	return { present: Array.isArray(raw), imported, user, known: knownRefs(version.id, imported.map((r) => r.proposition)), addId: randomUUID(),
		// the export's file name is case content (GRS-38): the package's view-content field, else the neutral name and a note
		exportName: exportFileName(viewContentOf(app().store, version.id), 'authorities_tab', AUTH_FILE) };
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const v = app().store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const values = valuesOf(f, AUTH_FIELDS) as AuthValues;
		if (!canAddAuthority(values)) return fail(400, { op: 'add', values, message: null });
		return addAction(v.case_id, STORES.authorities, values, formAddId(f));
	},
};
