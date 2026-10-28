import { error, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import { allPages, listPage, unavailable } from '../list-pages.server';

// The chronology rows of the published version. `?page=n` (default 1) answers the `list/page-<n>.json` shard as stored:
// one R2 read cold, none once it is in the Cache API. `?all=1` joins every page, from the Cache API when warm, for the
// page's filters and its CSV export. The version is in the URL, so both are immutable; they are a reader's case data, so
// no shared cache keeps them.
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
const PAGE = /^[1-9][0-9]{0,5}$/;

export async function GET({ locals, params, url, request }: RequestEvent) {
	const all = url.searchParams.get('all') === '1';
	const raw = url.searchParams.get('page') ?? '1';
	if (!all && !PAGE.test(raw)) error(400, { message: 'The page must be a whole number from 1.', code: 'bad-request' });
	const v = await publishedVersion(locals, params);
	if (all) return new Response(JSON.stringify(await allPages(locals, v)), { headers: { ...HEADERS, etag: `W/"all-${v.resultsVersion.slice('sha256:'.length)}"` } });
	const n = Number(raw);
	const shard = await listPage(locals, v, n);
	if (!shard) return n === 1 ? unavailable() : error(404, { message: 'Not found.', code: 'not-found' });
	const etag = shard.headers.get('etag');
	if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...HEADERS, etag } });
	return new Response(shard.body, { headers: { ...HEADERS, ...(etag ? { etag } : {}) } });
}
