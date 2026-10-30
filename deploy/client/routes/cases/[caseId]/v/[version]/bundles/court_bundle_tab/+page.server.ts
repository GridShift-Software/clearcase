import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { courtPure } from '$lib/views/bundles/pure.server';
import { bundleLinks } from '$lib/views/bundles/links.hosted';
import {
	bundleStore,
	customRows,
	toBundle,
	HEADER_STORE,
	CUSTOM_TABLE,
	fieldsHash,
	guarded,
} from '$lib/views/bundles/store.hosted';
import { customOf } from '$lib/bundles/builder';
import { HEADER_KEYS, headerRaw } from '$lib/views/bundles/court';
import { deleteStep } from '$lib/components/confirm-delete';
export const load = async ({ locals, params }: RequestEvent) => {
	const scope = await publishedVersion(locals, params),
		work = bundleStore(locals, scope);
	const [payload, rows, headers] = await Promise.all([
		shard<ReturnType<typeof courtPure>>(
			locals,
			params,
			'view/court_bundle_tab.json',
		),
		work.table(CUSTOM_TABLE),
		work.registers(HEADER_STORE),
	]);
	const { pathShard, ...data } = payload,
		links = bundleLinks(pathShard, scope.caseId);
	const custom = customRows(rows);
	for (const c of custom)
		if (c.assembledSha256) {
			const href = `${scope.base}/${encodeURIComponent(scope.resultsVersion)}/bundles/court_bundle_tab/assembled?id=${encodeURIComponent(c.id)}`;
			links.files[c.id] = href;
			links.downloads[c.id] = href;
		}
	return {
		...data,
		hosted: true,
		files: links.files,
		downloads: links.downloads,
		bundles: [...data.bundles, ...custom.map((c) => toBundle(c, c.id))],
		links: [
			...data.links,
			...custom.map((c) => ({
				file: c.assembledSha256 ? { ref: c.id, page: null } : null,
				indexFile: null,
				rows: c.rows.map((r) => ({
					slice: null,
					parts: r.parts.map(() => null),
					caselines: null,
				})),
			})),
		],
		header: headerRaw(data.header, headers[0]?.fields ?? null),
		headerStored: !!headers[0],
		headerHash: fieldsHash(headers[0]?.fields),
	};
};
async function headerAction(
	event: RequestEvent,
	action: 'header' | 'restore' | 'clear',
) {
	const scope = await publishedVersion(event.locals, event.params),
		work = bundleStore(event.locals, scope),
		f = await event.request.formData();
	if (action !== 'header' && deleteStep(f, action) !== 'confirm')
		return fail(400, { message: 'Confirmation is required.' });
	const values = Object.fromEntries(
		HEADER_KEYS.map((k) => [
			k,
			action === 'clear' ? '' : String(f.get(k) ?? '').replace(/\r\n?/g, '\n'),
		]),
	);
	if (Object.values(values).some((v) => v.length > 2000))
		return fail(400, {
			message: 'Each header field is limited to 2,000 characters.',
			values,
		});
	return guarded(async () => {
		const rows = await work.registers(HEADER_STORE);
		if (fieldsHash(rows[0]?.fields) !== String(f.get('version') ?? ''))
			return fail(409, {
				message: 'The header changed in another tab. Reload and try again.',
				values,
			});
		const payload =
			action === 'restore'
				? await shard<ReturnType<typeof courtPure>>(
						event.locals,
						event.params,
						'view/court_bundle_tab.json',
					)
				: null;
		const stored = headerRaw(payload?.header ?? values, null);
		await work.putSingle(HEADER_STORE, stored, rows[0] ?? null);
		return { saved: true, stored, version: fieldsHash(stored) };
	});
}
export const actions: Actions = {
	header: (e: RequestEvent) => headerAction(e, 'header'),
	restore: (e: RequestEvent) => headerAction(e, 'restore'),
	clear: (e: RequestEvent) => headerAction(e, 'clear'),
	save: async ({ locals, params, request }: RequestEvent) => {
		const scope = await publishedVersion(locals, params),
			f = await request.formData(),
			id = String(f.get('id') ?? ''),
			json = String(f.get('bundle') ?? '');
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || json.length > 2_000_000)
			return fail(400, { message: 'Invalid bundle.' });
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			return fail(400, { message: 'Invalid bundle.' });
		}
		const c = customOf(
			parsed && typeof parsed === 'object' ? { ...parsed, no: 'C' } : null,
		);
		if (!c || c.rows.length > 5000)
			return fail(400, { message: 'Invalid bundle.' });
		return guarded(async () => {
			const payload = await shard<ReturnType<typeof courtPure>>(
				locals,
				params,
				'view/court_bundle_tab.json',
			);
			return {
				saved: true,
				id,
				no: await bundleStore(locals, scope).putCustom(id, c, payload.bundles),
			};
		});
	},
	delete: async ({ locals, params, request }: RequestEvent) => {
		const scope = await publishedVersion(locals, params),
			id = String((await request.formData()).get('id') ?? '');
		return guarded(async () => {
			await bundleStore(locals, scope).deleteCustom(id);
			return { deleted: true, id };
		});
	},
};
