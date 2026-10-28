import { redirect, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion } from '$lib/views/hosted/payloads.server';

// `/search?q=…` is the search view: the same query, at the registry's route.
export async function load({ locals, params, url }: RequestEvent) {
	const v = await publishedVersion(locals, params);
	redirect(303, `${v.base}/${encodeURIComponent(v.resultsVersion)}/evidence/search${url.search}`);
}
