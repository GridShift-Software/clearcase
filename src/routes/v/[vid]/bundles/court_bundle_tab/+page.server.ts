import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { HEADER_FIELDS, HEADER_KEYS, bundlesOf, headerRaw } from '$lib/views/bundles/court';
import { resolveLocator } from '$lib/views/bundles/links';
import { bundlePathIndex } from '$lib/views/bundles/links.server';
import { HEADER_STORE, deleteSingle, guarded, putSingle, singleRow } from '$lib/views/bundles/store.server';
import type { Actions, PageServerLoad } from './$types';

const MAX_FIELD = 2000;
type Raw = { headerDefaults?: Record<string, unknown>; source?: unknown; indexSource?: unknown; caselinesSrc?: unknown };

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<Raw>(a.store, version.id, 'bundles');
	const bundles = bundlesOf(raw);
	const paths = bundlePathIndex(a.store, version.id);
	// links resolve only by exact indexed path; parts open at their first page when it is above 1, as v5's docLink does
	const links = bundles.map((b) => ({
		file: resolveLocator(paths, b.file), indexFile: resolveLocator(paths, b.indexFile),
		rows: b.rows.map((r) => ({
			slice: r.sliceUrl ? resolveLocator(paths, r.sliceUrl) : null,
			parts: r.parts.map((p) => resolveLocator(paths, p.url, p.from > 1 ? p.from : null)),
			caselines: r.caselines && typeof raw?.caselinesSrc === 'string' ? resolveLocator(paths, raw.caselinesSrc, r.caselines.from || null) : null,
		})),
	}));
	const vc = viewContentOf(a.store, version.id);
	const t = (f: string) => viewText(vc, 'court_bundle_tab', f);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const stored = singleRow(version.caseId, HEADER_STORE);
	return {
		present: raw !== null,
		bundles, links,
		content: {
			kpiBundlesNote: t('kpiBundlesNote'), kpiExtractsValue: vc.number('court_bundle_tab', 'kpiExtractsValue'), kpiExtractsNote: t('kpiExtractsNote'),
			extentNarrative: t('extentNarrative'),
			source: str(raw?.source) ?? t('compositionSourceDefault'), indexSource: str(raw?.indexSource) ?? t('indexSourceDefault'),
			examples: Object.fromEntries(HEADER_FIELDS.filter((f) => f.example).map((f) => [f.key, t(f.example!)])) as Record<string, string | null>,
			docxCreator: t('docxCreator'), allIndexesFileName: t('allIndexesFileName'),
		},
		header: headerRaw(raw?.headerDefaults ?? {}, stored ? stored.fields : null),
		headerStored: stored !== null,
	};
};

const versionCase = (vid: string) => app().store.getVersion(vid)?.case_id ?? null;

export const actions: Actions = {
	/** Save header: all eight fields (v5 cbHdrSave). */
	header: async ({ request, params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		// multipart form data sends line ends as CRLF; v5 stores a textarea's value with LF
		const values = Object.fromEntries(HEADER_KEYS.map((k) => [k, String(f.get(k) ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_FIELD)]));
		return guarded(values, async () => { await putSingle(c, HEADER_STORE, values); return { saved: true }; });
	},
	/** Restore matter defaults: the stored header is removed, so the imported defaults show (v5 cbHdrReset). */
	restore: async ({ params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		return guarded({}, async () => { await deleteSingle(c, HEADER_STORE); return { saved: true }; });
	},
	/** Clear all: every field stored empty, so placeholders print (v5 cbHdrClear). */
	clear: async ({ params }) => {
		const c = versionCase(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		return guarded({}, async () => { await putSingle(c, HEADER_STORE, Object.fromEntries(HEADER_KEYS.map((k) => [k, '']))); return { saved: true }; });
	},
};
