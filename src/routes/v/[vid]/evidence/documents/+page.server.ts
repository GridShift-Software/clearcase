import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import { documentsModel } from '$lib/views/evidence/documents';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const ev = evidenceRows(app().store, version.id);
	if (!ev) error(404, 'Unknown results version');
	const p = url.searchParams;
	return { total: ev.rows.length, failed: ev.failed, model: documentsModel(ev.rows, { bundle: p.get('bundle'), q: p.get('q') ?? '', page: p.get('page') }) };
};
