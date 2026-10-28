import { redirect, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion } from '$lib/views/hosted/payloads.server';

export async function load({ locals, params }: RequestEvent): Promise<never> {
	const v = await publishedVersion(locals, params);
	redirect(303, `${v.base}/${encodeURIComponent(v.resultsVersion)}/overview`);
}
