import type { RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { FacetsShard, ListPage } from '$lib/views/payloads/list';

// The chronology's filter options (the facets shard) and its first list page, read side by side under the request's one
// authorization; the page then fetches every row from `listHref?all=1` for the filters and the CSV export. Reading the
// first page here, not from the page's own load, spares the server render a second pass through the hooks (a session,
// grant and publication check of its own). The first HTML carries one page, not the whole list. Hosted has no
// view-content export name, so the CSV keeps the neutral one.
export async function load({ locals, params }: RequestEvent) {
	const [v, facets, first] = await Promise.all([publishedVersion(locals, params), shard<FacetsShard>(locals, params, 'list/facets.json'), shard<ListPage>(locals, params, 'list/page-1.json')]);
	const at = `${v.base}/${v.resultsVersion}/chronology`;
	return { exportName: { name: 'chronology.csv', note: null }, listHref: `${at}/list.json`, originalBase: `${at}/original`, facets, first, base: v.base };
}
