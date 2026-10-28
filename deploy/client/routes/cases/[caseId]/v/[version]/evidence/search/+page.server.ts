import type { RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import { searchPage, type SearchIndex } from '$lib/views/evidence/search';

// Advanced Search over the version's one index shard, with the local page's data. The index is one R2 read cold and none
// warm; the query lives in the URL. A published version has no failed row providers (the builder refuses one).
export async function load({ locals, params, url }: RequestEvent) {
	const [index, v] = await Promise.all([shard<SearchIndex>(locals, params, 'search/index.json'), publishedVersion(locals, params)]);
	return { ...searchPage(index.rows, url.searchParams), failed: [], exportName: { name: 'search.csv', note: null }, base: v.base };
}
