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
import { env } from 'cloudflare:workers';
import { contractError } from '$lib/server/runtime/errors';
import { MARK_REQUEST_KEYS } from '$lib/views/bundles/ops';

function markBatchRows() {
	try {
		const config: unknown = JSON.parse(
			String(env.CLEARCASE_NATIVE_CONFIG ?? '{}'),
		);
		if (config && typeof config === 'object' && 'userWorkLimits' in config) {
			const limits = config.userWorkLimits;
			if (
				limits &&
				typeof limits === 'object' &&
				'maxStatementsPerBatch' in limits &&
				typeof limits.maxStatementsPerBatch === 'number' &&
				Number.isSafeInteger(limits.maxStatementsPerBatch) &&
				limits.maxStatementsPerBatch >= 8
			)
				return Math.min(MARK_REQUEST_KEYS, limits.maxStatementsPerBatch - 3);
		}
	} catch {}
	return 5; // The adapter's minimum is eight statements, three of which are transaction bookkeeping.
}
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
		keys.length > MARK_REQUEST_KEYS ||
		!keys.every(
			(k): k is string =>
				typeof k === 'string' && k.length > 0 && k.length <= 4096,
		) ||
		(action === 'co' && val !== 'C' && val !== 'O')
	)
		return fail(400, { message: 'Invalid marks.' });
	return guarded(async () => {
		let revision = await e.locals.store.stateRevision({ caseId: scope.caseId });
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
		const next = [...new Set(keys)].map((key) => ({
			case_id: scope.caseId,
			locator: key,
			selected:
				action === 'select'
					? f.get('on') === '1'
						? 1
						: 0
					: (map.get(key)?.cells.selected ?? 0),
			co: action === 'co' ? String(val) : (map.get(key)?.cells.co ?? null),
		}));
		const chunk = markBatchRows();
		for (let offset = 0; offset < next.length; offset += chunk) {
			const result = await e.locals.userWork.putTableRows({
				caseId: scope.caseId,
				table: MARK_TABLE,
				owner: OWNER,
				rows: next.slice(offset, offset + chunk),
				expectedRevision: revision,
				operationId: crypto.randomUUID(),
			});
			if (result.kind !== 'written') throw contractError(result.kind);
			revision = result.caseRevision;
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
