import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf } from '$lib/local-case/results.server';
import { infoRows, saveDone, type InfoItem } from '$lib/analysis/info-required.server';
import type { Actions, PageServerLoad } from './$types';

const itemsOf = (vid: string) => datasetOf<InfoItem[]>(app().store, vid, 'info-required') ?? [];

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const { rows, detached } = infoRows(app().userWork, version.caseId, itemsOf(version.id));
	return { rows, detached };
};

export const actions: Actions = {
	// One item's done flag. A busy store answers 503 after its retries: the form gets the values back with the error,
	// so nothing the operator chose is lost and a retry saves it.
	toggle: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const key = String(f.get('key') ?? '');
		const done = f.get('done') === 'true';
		try {
			if (!(await saveDone(a.userWork, v.case_id, v.id, itemsOf(v.id), key, done))) return fail(400, { key, done, message: 'This item is not in this results version.' });
		} catch (e) {
			if (isHttpError(e)) return fail(e.status, { key, done, message: `Not saved: ${e.body.message}` });
			throw e;
		}
		return { saved: key, done };
	},
};
