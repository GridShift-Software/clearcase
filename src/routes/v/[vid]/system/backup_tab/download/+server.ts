import { backupFile } from '$lib/views/system/backup.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const f = backupFile(params.vid, null);
	return new Response(f.body, {
		headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' },
	});
};
