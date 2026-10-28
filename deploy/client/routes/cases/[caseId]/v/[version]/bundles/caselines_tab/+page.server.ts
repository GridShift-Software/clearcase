import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { caselinesPure } from '$lib/views/bundles/pure.server';
import { bundleLinks } from '$lib/views/bundles/links.hosted';
import {
	bundleStore,
	LINKS_STORE,
	guarded,
} from '$lib/views/bundles/store.hosted';
import {
	MAX_QUERY,
	MAX_SHOWN,
	searchPages,
	linkedName,
	linkedPath,
} from '$lib/views/bundles/caselines';
import { locatorPath } from '$lib/views/bundles/links';
import { hostedWork } from '$lib/views/hosted/work-adapter.server';
export const load = async ({ locals, params, url }: RequestEvent) => {
	const scope = await publishedVersion(locals, params),
		work = bundleStore(locals, scope);
	const [payload, rows] = await Promise.all([
		shard<ReturnType<typeof caselinesPure>>(
			locals,
			params,
			'view/caselines_tab.json',
		),
		work.registers(LINKS_STORE),
	]);
	const { pathShard, index, ...data } = payload,
		links = bundleLinks(pathShard, scope.caseId);
	const raw = url.searchParams.get('q') ?? '',
		qTooLong = raw.length > MAX_QUERY,
		q = qTooLong ? '' : raw,
		hits = q.trim() && index.length ? searchPages(index, q) : null;
	return {
		...data,
		hosted: true,
		files: links.files,
		downloads: links.downloads,
		q,
		qTooLong,
		search: hits
			? {
					total: hits.length,
					occurrences: hits.reduce((n, h) => n + h.count, 0),
					hits: hits.slice(0, MAX_SHOWN),
				}
			: null,
		links: rows
			.map((r) => ({
				rowId: r.rowId,
				path: String(r.fields.path ?? ''),
				seq: Number(r.fields.seq) || 0,
			}))
			.sort((a, b) => a.seq - b.seq || a.rowId.localeCompare(b.rowId))
			.map((r) => ({
				...r,
				name: linkedName(r.path),
				ref: links.paths.get(r.path) ?? null,
			})),
	};
};
export const actions: Actions = {
	link: async (e: RequestEvent) => {
		const scope = await publishedVersion(e.locals, e.params),
			path = linkedPath(String((await e.request.formData()).get('path') ?? ''));
		if (!path) return { saved: false };
		if (
			path.length > 2048 ||
			locatorPath('./' + path.split('/').map(encodeURIComponent).join('/')) !==
				path
		)
			return fail(400, { message: 'Give a path inside the case folder.' });
		return guarded(async () => {
			const rows = await bundleStore(e.locals, scope).registers(LINKS_STORE);
			await hostedWork(e.locals, scope.caseId, scope.resultsVersion).putRow(
				scope.caseId,
				LINKS_STORE,
				null,
				{
					path,
					seq: Math.max(0, ...rows.map((r) => Number(r.fields.seq) || 0)) + 1,
				},
			);
			return { saved: true };
		});
	},
	unlink: async (e: RequestEvent) => {
		const scope = await publishedVersion(e.locals, e.params),
			id = String((await e.request.formData()).get('id') ?? '');
		return guarded(async () => {
			const row = (
				await bundleStore(e.locals, scope).registers(LINKS_STORE)
			).find((r) => r.rowId === id);
			if (!row) return { saved: true };
			const f = new FormData();
			f.set('version', row.version);
			await hostedWork(
				e.locals,
				scope.caseId,
				scope.resultsVersion,
				f,
			).deleteRow(scope.caseId, LINKS_STORE, id);
			return { saved: true };
		});
	},
};
