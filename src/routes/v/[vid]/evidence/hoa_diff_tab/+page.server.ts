import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import { candidates, compare } from '$lib/views/evidence/diff';
import { coverage } from '$lib/views/evidence/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const ev = evidenceRows(app().store, version.id);
	if (!ev) error(404, 'Unknown results version');
	const p = url.searchParams;
	return {
		candidates: candidates(ev.rows),
		chosen: { a: p.get('a') ?? '', b: p.get('b') ?? '', mode: p.get('mode') === 'lines' ? 'lines' : 'words' },
		result: compare(ev.rows, p.get('a'), p.get('b'), p.get('mode'), p.has('a') || p.has('b')),
		coverage: coverage(ev.rows),
		failed: ev.failed,
	};
};
