import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import type { RequestHandler } from './$types';

// Per-version chronology list, built once at import and stored with the version, served as-is. The browser may keep a
// copy but must revalidate it (private, no-cache): the ETag is the version's read-model digest, so an unchanged
// version costs a 304 and content stored again under the same id is never shown from a stale copy.
export const GET: RequestHandler = ({ params, request }) => {
	const a = app();
	const v = a.store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	const check = a.verify(v.id);
	if (!check.ok) error(409, `Results version ${v.id} failed its integrity check (${check.reason}).`);
	const etag = `"${v.read_model_sha256}"`;
	const headers = { 'content-type': 'application/json', 'cache-control': 'private, no-cache', etag };
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	return new Response(a.store.chronologyJson(v.id), { headers });
};
