import type { RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { FacetsShard } from '$lib/views/payloads/list';

// The chronology's filter options from the facets shard and where its rows come from: the page loads the first list page
// from `listHref`, then every row for the filters and the CSV export. The list pages are never read here, so the first
// HTML carries one page, not the whole list. Hosted has no view-content export name, so the CSV keeps the neutral one.
export async function load({ locals, params }: RequestEvent) {
	const [v, facets] = await Promise.all([publishedVersion(locals, params), shard<FacetsShard>(locals, params, 'list/facets.json')]);
	const at = `${v.base}/${v.resultsVersion}/chronology`;
	return { exportName: { name: 'chronology.csv', note: null }, listHref: `${at}/list.json`, originalBase: `${at}/original`, facets, base: v.base };
}
