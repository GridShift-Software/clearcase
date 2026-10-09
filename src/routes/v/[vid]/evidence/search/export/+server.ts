import { error } from '@sveltejs/kit';
import { toCSV } from '$lib/components/csv';
import { app } from '$lib/local-case/app.server';
import { searchRowsOf } from '$lib/views/evidence/rows.server';
import { exportRows, invalidReason, queryFromParams, searchRows } from '$lib/views/evidence/search';
import type { RequestHandler } from './$types';

// The search export: every row of the submitted search (all rows before any search, as v5), in result order (BA-17).
// The /v/[vid] layout's version check does not run for endpoints, so the version is checked here.
export const GET: RequestHandler = ({ params, url }) => {
	const a = app();
	const v = a.store.getVersion(params.vid);
	if (!v || !a.verify(v.id).ok) error(404, 'Unknown results version');
	const rows = searchRowsOf(a.store, v.id);
	if (!rows) error(404, 'Unknown results version');
	const { query } = queryFromParams(url.searchParams);
	const invalid = invalidReason(query);
	if (invalid) error(400, invalid);
	return new Response(toCSV(exportRows(searchRows(rows, query))), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
};
