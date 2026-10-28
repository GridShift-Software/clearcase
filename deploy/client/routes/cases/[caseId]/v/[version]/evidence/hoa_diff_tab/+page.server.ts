import type { RequestEvent } from '@sveltejs/kit';
import type { ChronologyListRow } from '$lib/local-case/model';
import { candidates, compare } from '$lib/views/evidence/diff';
import { coverage, type SearchIndex } from '$lib/views/evidence/search';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';

export async function load({ locals, params, url }: RequestEvent) {
	const [index, v] = await Promise.all([shard<SearchIndex>(locals, params, 'search/index.json'), publishedVersion(locals, params)]);
	// Diff reads ref, filename, excerpt and textStatus; the remaining list fields are not published in the index.
	const rows: ChronologyListRow[] = index.rows.map((r, ord) => ({ ...r, ord, dateType: null, dateSource: null, alsoIn: [], url: '', parentRef: null, preview: 'none', attachments: 0 }));
	const p = url.searchParams;
	return {
		candidates: candidates(rows),
		chosen: { a: p.get('a') ?? '', b: p.get('b') ?? '', mode: p.get('mode') === 'lines' ? 'lines' : 'words' },
		result: compare(rows, p.get('a'), p.get('b'), p.get('mode'), p.has('a') || p.has('b')),
		coverage: coverage(rows), failed: [], base: v.base,
	};
}
