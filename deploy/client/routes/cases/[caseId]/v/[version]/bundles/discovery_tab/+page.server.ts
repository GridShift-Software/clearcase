import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { discoveryPure } from '$lib/views/bundles/pure.server';
import { bundleLinks } from '$lib/views/bundles/links.hosted';
import {
	bundleStore,
	MARK_TABLE,
	MODE_STORE,
	OWNER,
	guarded,
} from '$lib/views/bundles/store.hosted';
import { hostedWork } from '$lib/views/hosted/work-adapter.server';
export const load = async ({ locals, params }: RequestEvent) => {
	const scope = await publishedVersion(locals, params),
		work = bundleStore(locals, scope);
	const [payload, rows, modes] = await Promise.all([
		shard<ReturnType<typeof discoveryPure>>(
			locals,
			params,
			'view/discovery_tab.json',
		),
		work.table(MARK_TABLE),
		work.registers(MODE_STORE),
	]);
	const { pathShard, ...data } = payload,
		links = bundleLinks(pathShard, scope.caseId);
	return {
		...data,
		files: links.files,
		downloads: links.downloads,
		mode:
			modes[0]?.fields.mode === 'supplementary' ? 'supplementary' : 'discovery',
		selected: rows
			.filter((r) => r.cells.selected === 1)
			.map((r) => String(r.cells.locator)),
		marks: rows.flatMap((r) =>
			r.cells.co === 'C' || r.cells.co === 'O'
				? [[String(r.cells.locator), r.cells.co] as const]
				: [],
		),
	};
};
async function mark(e: RequestEvent, action: 'select' | 'co') {
	const scope = await publishedVersion(e.locals, e.params),
		f = await e.request.formData(),
		keys = f.getAll('key'),
		val = f.get('val'),
		base = f.getAll('base');
	if (
		keys.length > 5000 ||
		!keys.every(
			(k): k is string =>
				typeof k === 'string' && k.length > 0 && k.length <= 4096,
		) ||
		(action === 'co' && val !== 'C' && val !== 'O')
	)
		return fail(400, { message: 'Invalid marks.' });
	return guarded(async () => {
		const work = bundleStore(e.locals, scope),
			rows = await work.table(MARK_TABLE),
			map = new Map(rows.map((r) => [String(r.cells.locator), r]));
		if (action === 'co') {
			const conflicts = keys.flatMap((locator, i) => {
				const stored = map.get(locator)?.cells.co ?? null;
				return base.length === keys.length &&
					stored !== (base[i] || null) &&
					stored !== val
					? [{ locator, stored }]
					: [];
			});
			if (conflicts.length)
				return fail(409, {
					message: 'Marks changed in another tab. Retry or discard.',
					conflicts,
				});
		}
		for (const key of new Set(keys)) {
			const old = map.get(key),
				form = new FormData();
			if (old) form.set('version', old.version);
			await hostedWork(
				e.locals,
				scope.caseId,
				scope.resultsVersion,
				form,
			).putTableRow(
				MARK_TABLE,
				{
					case_id: scope.caseId,
					locator: key,
					selected:
						action === 'select'
							? f.get('on') === '1'
								? 1
								: 0
							: (old?.cells.selected ?? 0),
					co: action === 'co' ? String(val) : (old?.cells.co ?? null),
				},
				{ owner: OWNER },
			);
		}
		return { saved: keys.length };
	});
}
export const actions: Actions = {
	select: (e: RequestEvent) => mark(e, 'select'),
	co: (e: RequestEvent) => mark(e, 'co'),
	mode: async (e: RequestEvent) => {
		const scope = await publishedVersion(e.locals, e.params),
			mode = (await e.request.formData()).get('mode');
		if (mode !== 'discovery' && mode !== 'supplementary')
			return fail(400, { message: 'Unknown schedule.' });
		return guarded(async () => {
			await bundleStore(e.locals, scope).putSingle(MODE_STORE, { mode });
			return { saved: true };
		});
	},
};
