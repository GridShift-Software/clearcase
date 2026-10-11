// "Write updated index to file": the additions of this version as v5's ess_dcs_rescan_v1.json.
import { indexFile } from '$lib/views/system/rescan.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => new Response(indexFile(params.vid), {
	headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="ess_dcs_rescan_v1.json"', 'cache-control': 'no-store' },
});
