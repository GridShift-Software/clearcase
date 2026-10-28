import { error, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '$lib/server/runtime/hosted/http';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import type { ListPage } from '$lib/views/payloads/list';

// The chronology rows of the published version. `?page=n` (default 1) answers the `list/page-<n>.json` shard as stored:
// one R2 read cold, none once it is in the Cache API. `?all=1` joins every page, from the Cache API when warm, for the
// page's filters and its CSV export. The version is in the URL, so both are immutable; they are a reader's case data, so
// no shared cache keeps them.
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
const PAGE = /^[1-9][0-9]{0,5}$/;
const unavailable = (): never => error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'storage-unavailable' });

export async function GET({ locals, params, url, request }: RequestEvent) {
	const all = url.searchParams.get('all') === '1';
	const raw = url.searchParams.get('page') ?? '1';
	if (!all && !PAGE.test(raw)) error(400, { message: 'The page must be a whole number from 1.', code: 'bad-request' });
	const v = await publishedVersion(locals, params);
	const read = (n: number) => locals.shards.read({ caseId: v.caseId, resultsVersion: v.resultsVersion, name: `list/page-${n}.json` }).catch((e: unknown) => refuse(e));
	if (all) {
		const first = await read(1) ?? unavailable();
		const p1 = (await first.json()) as ListPage;
		const rest = await Promise.all(Array.from({ length: p1.pages - 1 }, async (_, i) => ((await (await read(i + 2) ?? unavailable()).json()) as ListPage).rows));
		const body: ListPage = { page: 1, pages: 1, total: p1.total, rows: p1.rows.concat(...rest) };
		return new Response(JSON.stringify(body), { headers: { ...HEADERS, etag: `W/"all-${v.resultsVersion.slice('sha256:'.length)}"` } });
	}
	const n = Number(raw);
	const shard = await read(n);
	if (!shard) return n === 1 ? unavailable() : error(404, { message: 'Not found.', code: 'not-found' });
	const etag = shard.headers.get('etag');
	if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...HEADERS, etag } });
	return new Response(shard.body, { headers: { ...HEADERS, ...(etag ? { etag } : {}) } });
}
