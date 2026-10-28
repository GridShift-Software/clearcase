// The published version's chronology list pages, read through the shard reader (Cache API, then R2). The caller has
// resolved the version with `publishedVersion`, which authorized the case.
import { error } from '@sveltejs/kit';
import type { ChronologyListRow } from '$lib/local-case/model';
import type { RequestServices } from '$lib/server/runtime/contracts';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { PublishedVersion } from '$lib/views/hosted/payloads.server';
import type { ListPage } from '$lib/views/payloads/list';

export const unavailable = (): never => error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'storage-unavailable' });

/** `list/page-<n>.json` as stored, or null past the last page (a page the publication does not admit is never read). */
export function listPage(locals: RequestServices, v: PublishedVersion, n: number): Promise<Response | null> {
	const name = `list/page-${n}.json`, admitted = v.publication.shards ?? {};
	if (!Object.hasOwn(admitted, name)) return Promise.resolve(null);
	return locals.shards.read({ caseId: v.caseId, resultsVersion: v.resultsVersion, name, bytes: admitted[name]! }).catch((e: unknown) => refuse(e));
}

/** Every page joined in list order. A page the first one promised but storage lacks is a 503. */
export async function allPages(locals: RequestServices, v: PublishedVersion): Promise<ListPage> {
	const p1 = (await ((await listPage(locals, v, 1)) ?? unavailable()).json()) as ListPage;
	const rest = await Promise.all(Array.from({ length: p1.pages - 1 }, async (_, i) => ((await ((await listPage(locals, v, i + 2)) ?? unavailable()).json()) as ListPage).rows));
	return { page: 1, pages: 1, total: p1.total, rows: p1.rows.concat(...rest) };
}

/** The version's document row for `ref`, or null when the version has no such document. */
export const documentRow = async (locals: RequestServices, v: PublishedVersion, ref: string): Promise<ChronologyListRow | null> =>
	(await allPages(locals, v)).rows.find((r) => r.ref === ref) ?? null;
