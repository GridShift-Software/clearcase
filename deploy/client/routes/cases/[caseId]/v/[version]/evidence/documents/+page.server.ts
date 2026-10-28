import type { RequestEvent } from '@sveltejs/kit';
import { documentsModel } from '$lib/views/evidence/documents';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { DocumentsDefaultShard } from '$lib/views/payloads/documents';
import type { ListPage } from '$lib/views/payloads/list';

// The local documents loader over shards. A request with no bundle, no filter text and page 1 is answered by one shard,
// `documents/default.json` (the model that request has locally). Any other request reads the list pages (from the Cache
// API once warm), filters them and pages at 60, so the totals are the case's own.
export async function load({ locals, params, url }: RequestEvent) {
	const p = url.searchParams;
	const bundle = p.get('bundle'), q = p.get('q') ?? '', page = p.get('page');
	if (bundle === null && q === '' && (page === null || page === '1')) {
		const [d, v] = await Promise.all([shard<DocumentsDefaultShard>(locals, params, 'documents/default.json'), publishedVersion(locals, params)]);
		return { total: d.total, failed: [], model: d.model, base: v.base };
	}
	const [first, v] = await Promise.all([shard<ListPage>(locals, params, 'list/page-1.json'), publishedVersion(locals, params)]);
	const rest = await Promise.all(Array.from({ length: first.pages - 1 }, (_, i) => shard<ListPage>(locals, params, `list/page-${i + 2}.json`)));
	const rows = [first, ...rest].flatMap((l) => l.rows);
	return { total: rows.length, failed: [], model: documentsModel(rows, { bundle, q, page }), base: v.base };
}
