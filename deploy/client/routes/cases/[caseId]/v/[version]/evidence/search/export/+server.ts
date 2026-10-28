import { error, type RequestEvent } from '@sveltejs/kit';
import { toCSV } from '$lib/components/csv';
import { docPath } from '$lib/local-case/model';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import { exportRows, invalidReason, queryFromParams, searchOptions, searchRows, type SearchIndex } from '$lib/views/evidence/search';

// The CSV of the submitted search (every row before any search), in index order, as the local export. An endpoint does not
// run the layout, so the version is authorized here, by the same read the pages make.
export async function GET({ locals, params, url }: RequestEvent) {
	const [index, v] = await Promise.all([shard<SearchIndex>(locals, params, 'search/index.json'), publishedVersion(locals, params)]);
	const { query } = queryFromParams(url.searchParams);
	const invalid = invalidReason(query, searchOptions(index.rows));
	if (invalid) error(400, invalid);
	const rows = searchRows(index.rows, query).map((r) => ({ ...r, url: docPath(v.resultsVersion, r.ref, null, v.base) }));
	return new Response(toCSV(exportRows(rows)), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
}
