import { indexFile, indexName } from '$lib/views/system/rescan.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => new Response(indexFile(params.vid), {
	headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${indexName(params.vid).name}"`, 'cache-control': 'no-store' },
});
