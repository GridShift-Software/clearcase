import { error, fail } from '@sveltejs/kit';
import { actionCase } from '$lib/local-case/answer.server';
import { app, originals } from '$lib/local-case/app.server';
import { facetsOf } from '$lib/local-case/chronology';
import { listJson } from '$lib/local-case/documents.server';
import { versionPath } from '$lib/local-case/model';
import { exportFileName, viewContentOf } from '$lib/local-case/results.server';
import { localOriginal } from '$lib/views/evidence/local-original.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import { LIST_PAGE_ROWS, type ListPage } from '$lib/views/payloads/list';
import type { Actions, PageServerLoad } from './$types';

// The first list page and the filter options; the page fetches every row from the chronology API once it shows, so the
// first HTML carries one page of rows, not the whole list.
export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const ev = evidenceRows(app().store, version.id);
	if (!ev) error(404, 'Unknown results version');
	// The degraded providers come from this request's list, as the API's header does: the parsed rows are cached by the
	// list's etag, which names a failed provider but not why it failed.
	const failed = listJson(app().store, version.id)?.failed ?? ev.failed;
	const first: ListPage = { page: 1, pages: Math.max(1, Math.ceil(ev.rows.length / LIST_PAGE_ROWS)), total: ev.rows.length, rows: ev.rows.slice(0, LIST_PAGE_ROWS) };
	return { exportName: exportFileName(viewContentOf(app().store, version.id), 'chronology', 'chronology.csv'), listHref: `/api${versionPath(version.id)}/chronology`, facets: facetsOf(ev.rows), first, failed };
};

export const actions: Actions = {
	/** The pane's original: a document's own original links, as its document page offers them; 404 for a ref outside the version. */
	original: async ({ params, request }) => {
		const { vid } = actionCase(params);
		const ref = (await request.formData()).get('ref');
		const original = typeof ref === 'string' ? await localOriginal(app().store, originals(), vid, ref) : null;
		return original ? { original } : fail(404, { original: null });
	},
};
