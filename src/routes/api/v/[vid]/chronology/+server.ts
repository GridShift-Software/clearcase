import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { listJson } from '$lib/local-case/documents.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) => {
	const a = app();
	const v = a.store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	const check = a.verify(v.id);
	if (!check.ok) error(409, `Results version ${v.id} failed its integrity check (${check.reason}).`);
	const list = listJson(a.store, v.id)!;
	const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'private, no-cache', etag: list.etag };
	// a provider that failed is left out of the list; the page shows the degraded state from this header
	if (list.failed.length) headers['x-clearcase-degraded'] = encodeURIComponent(JSON.stringify(list.failed));
	if (request.headers.get('if-none-match') === list.etag) return new Response(null, { status: 304, headers });
	return new Response(list.json, { headers });
};
