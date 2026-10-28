import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { facetsOf } from '$lib/local-case/chronology';
import { versionPath } from '$lib/local-case/model';
import { exportFileName, viewContentOf } from '$lib/local-case/results.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import { LIST_PAGE_ROWS, type ListPage } from '$lib/views/payloads/list';
import type { PageServerLoad } from './$types';

// The first list page and the filter options; the page fetches every row from the chronology API once it shows, so the
// first HTML carries one page of rows, not the whole list.
export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const ev = evidenceRows(app().store, version.id);
	if (!ev) error(404, 'Unknown results version');
	const first: ListPage = { page: 1, pages: Math.max(1, Math.ceil(ev.rows.length / LIST_PAGE_ROWS)), total: ev.rows.length, rows: ev.rows.slice(0, LIST_PAGE_ROWS) };
	return { exportName: exportFileName(viewContentOf(app().store, version.id), 'chronology', 'chronology.csv'), listHref: `/api${versionPath(version.id)}/chronology`, facets: facetsOf(ev.rows), first, failed: ev.failed };
};
