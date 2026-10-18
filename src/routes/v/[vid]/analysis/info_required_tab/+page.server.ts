import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf } from '$lib/local-case/results.server';
import { infoRows, itemKeys, saveDone, type InfoItem } from '$lib/analysis/info-required.server';
import type { Actions, PageServerLoad } from './$types';

const itemsOf = (vid: string) => datasetOf<InfoItem[]>(app().store, vid, 'info-required') ?? [];

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const { rows, detached } = infoRows(app().userWork, version.caseId, itemsOf(version.id));
	return { rows, detached };
};

const carried = (f: FormData, items: InfoItem[], except: string) => {
	const keys = new Set(itemKeys(items));
	const out: { key: string; done: boolean; message: string }[] = [];
	for (const raw of f.getAll('pending')) {
		try {
			const p = JSON.parse(String(raw));
			const key = String(p.key);
			if (key !== except && keys.has(key) && !out.some((o) => o.key === key)) out.push({ key, done: p.done === true, message: String(p.message ?? 'Not saved.').slice(0, 300) });
		} catch {}
	}
	return out;
};

export const actions: Actions = {
	toggle: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const key = String(f.get('key') ?? '');
		const done = f.get('done') === 'true';
		const items = itemsOf(v.id);
		const pending = carried(f, items, key);
		try {
			if (!(await saveDone(a.userWork, v.case_id, v.id, items, key, done))) return fail(400, { key, done, message: 'This item is not in this results version.', pending });
		} catch (e) {
			if (isHttpError(e)) return fail(e.status, { key, done, message: `Not saved: ${e.body.message}`, pending });
			throw e;
		}
		return { saved: key, done, pending };
	},
};
