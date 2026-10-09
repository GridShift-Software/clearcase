import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { listJson } from '$lib/local-case/documents.server';
import type { RequestHandler } from './$types';

// Per-version chronology list through the document-row contract (documents.server.ts): the list stored at import,
// served as-is, plus rows from registered providers (none in the pilot); a provider that throws is left out, never a 500. The browser may keep a copy but must
// revalidate it (private, no-cache): the ETag is the read-model digest (and provider revisions), so an unchanged
// version costs a 304 and content stored again under the same id is never shown from a stale copy.
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
