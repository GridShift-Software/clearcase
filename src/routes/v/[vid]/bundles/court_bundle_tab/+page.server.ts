import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { HEADER_FIELDS, HEADER_KEYS, bundlesOf, headerRaw } from '$lib/views/bundles/court';
import { resolveLocator } from '$lib/views/bundles/links';
import { bundleDownloads, bundleLinks } from '$lib/views/bundles/links.server';
import { HEADER_STORE, deleteCustom, deleteSingle, guarded, putSingle, readCustom, saveCustom, serial, singleHash, singleRow } from '$lib/views/bundles/store.server';
import { customOf, toBundle } from '$lib/bundles/builder';
import type { Actions, PageServerLoad } from './$types';

const MAX_FIELD = 2000;
type Raw = { headerDefaults?: Record<string, unknown>; source?: unknown; indexSource?: unknown; caselinesSrc?: unknown };

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<Raw>(a.store, version.id, 'bundles');
	const shipped = bundlesOf(raw);
	const custom = (await readCustom(version.caseId)).map((c) => toBundle(c, c.id));
	const { paths, files } = await bundleLinks(a.store, version.id);
	const links = [...shipped.map((b) => ({
		file: resolveLocator(paths, b.file), indexFile: resolveLocator(paths, b.indexFile),
		rows: b.rows.map((r) => ({
			slice: r.sliceUrl ? resolveLocator(paths, r.sliceUrl) : null,
			parts: r.parts.map((p) => resolveLocator(paths, p.url, p.from > 1 ? p.from : null)),
			caselines: r.caselines && typeof raw?.caselinesSrc === 'string' ? resolveLocator(paths, raw.caselinesSrc, r.caselines.from || null) : null,
		})),
	})), ...custom.map((b) => ({ file: null, indexFile: null, rows: b.rows.map((r) => ({ slice: null, parts: r.parts.map(() => null), caselines: null })) }))];
	const bundles = [...shipped, ...custom];
	const vc = viewContentOf(a.store, version.id);
	const t = (f: string) => viewText(vc, 'court_bundle_tab', f);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const stored = singleRow(version.caseId, HEADER_STORE);
	const refs = links.flatMap((l) => [l.file, l.indexFile, ...l.rows.flatMap((r) => [r.slice, ...r.parts, r.caselines])]).filter((r) => r !== null).map((r) => r.ref);
	return {
		present: raw !== null,
		bundles, links,
		files,
		content: {
			kpiBundlesNote: t('kpiBundlesNote'), kpiExtractsValue: vc.number('court_bundle_tab', 'kpiExtractsValue'), kpiExtractsNote: t('kpiExtractsNote'),
			extentNarrative: t('extentNarrative'),
			source: str(raw?.source) ?? t('compositionSourceDefault'), indexSource: str(raw?.indexSource) ?? t('indexSourceDefault'),
			examples: Object.fromEntries(HEADER_FIELDS.filter((f) => f.example).map((f) => [f.key, t(f.example!)])) as Record<string, string | null>,
			docxCreator: t('docxCreator'), allIndexesFileName: t('allIndexesFileName'),
		},
		header: headerRaw(raw?.headerDefaults ?? {}, stored ? stored.fields : null),
		headerStored: stored !== null,
		headerHash: singleHash(version.caseId, HEADER_STORE),
		downloads: Object.fromEntries(await bundleDownloads(version.id, refs)),
	};
};

const versionCase = (vid: string) => app().store.getVersion(vid)?.case_id ?? null;
const CONFLICT = 'Not saved: the header was changed in another tab since this page loaded. Your typed fields are kept and the stored header is shown below; Retry saves yours over it, or use the stored header.';

function headerWrite(vid: string, c: string, version: string, values: Record<string, string>, write: () => Promise<void>) {
	return guarded(values, () => serial(c, HEADER_STORE, async () => {
		const now = singleHash(c, HEADER_STORE);
		if (version !== now) {
			const raw = datasetOf<Raw>(app().store, vid, 'bundles');
			return fail(409, { message: CONFLICT, values, stored: headerRaw(raw?.headerDefaults ?? {}, singleRow(c, HEADER_STORE)?.fields ?? null), version: now });
		}
		await write();
		return { saved: true, version: singleHash(c, HEADER_STORE) };
	}));
}
const versionOf = (f: FormData) => String(f.get('version') ?? '');
const MAX_ROWS = 5000, MAX_JSON = 2_000_000;

export const actions: Actions = {
	header: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		// multipart form data sends line ends as CRLF; v5 stores a textarea's value with LF
		const values = Object.fromEntries(HEADER_KEYS.map((k) => [k, String(f.get(k) ?? '').replace(/\r\n?/g, '\n')]));
		const long = HEADER_FIELDS.find((x) => values[x.key]!.length > MAX_FIELD);
		if (long) return fail(400, { message: `Not saved: “${long.label}” is ${values[long.key]!.length.toLocaleString('en')} characters; the limit is ${MAX_FIELD.toLocaleString('en')} per field. Your typed fields are kept.`, values, field: long.key });
		return headerWrite(params.vid, c, versionOf(f), values, () => putSingle(c, HEADER_STORE, values));
	},
	restore: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		return headerWrite(params.vid, c, versionOf(await request.formData()), {}, () => deleteSingle(c, HEADER_STORE));
	},
	clear: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		return headerWrite(params.vid, c, versionOf(await request.formData()), {}, () => putSingle(c, HEADER_STORE, Object.fromEntries(HEADER_KEYS.map((k) => [k, '']))));
	},
	save: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const id = String(f.get('id') ?? ''), json = String(f.get('bundle') ?? '');
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(400, { message: 'Not saved: the bundle has no valid id.' });
		if (json.length > MAX_JSON) return fail(400, { message: 'Not saved: the item list is too large to keep.' });
		let parsed: unknown = null;
		try { parsed = JSON.parse(json); } catch { parsed = null; }
		const entry = customOf(parsed && typeof parsed === 'object' ? { ...parsed, no: 'C' } : null);
		if (!entry) return fail(400, { message: 'Not saved: the bundle could not be read.' });
		if (entry.rows.length > MAX_ROWS) return fail(400, { message: `Not saved: a saved bundle keeps at most ${MAX_ROWS.toLocaleString('en')} items.` });
		const shipped = bundlesOf(datasetOf<Raw>(app().store, params.vid, 'bundles'));
		return guarded({ id }, async () => ({ saved: true, id, no: await saveCustom(c, id, entry, shipped) }));
	},
	delete: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const id = String((await request.formData()).get('id') ?? '');
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(400, { message: 'Not deleted: the bundle has no valid id.' });
		return guarded({ id }, async () => { await deleteCustom(c, id); return { deleted: true, id }; });
	},
};
