import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { MAX_QUERY, MAX_SHOWN, coverage, linkedName, linkedPath, searchPages, type PageText } from '$lib/views/bundles/caselines';
import { locatorPath, resolveLocator } from '$lib/views/bundles/links';
import { bundleDownloads, bundlePathIndex } from '$lib/views/bundles/links.server';
import { LINKS_STORE as LINKS, addLink, guarded, serial } from '$lib/views/bundles/store.server';
import type { Actions, PageServerLoad } from './$types';


const encode = (path: string) => './' + path.split('/').map(encodeURIComponent).join('/');

/** The page-text index as [page, text] pairs; malformed entries are left out. */
function pageIndex(raw: unknown): PageText[] {
	const idx = (raw as { index?: unknown } | null)?.index;
	return Array.isArray(idx) ? idx.filter((e): e is [number, string] => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === 'string') : [];
}

export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<{ pages?: unknown }>(a.store, version.id, 'caselines-index');
	const index = pageIndex(raw);
	const vc = viewContentOf(a.store, version.id);
	// the page count from the index, else the source's fallback figure (view-content), else unknown
	const fallback = vc.number('caselines_tab', 'pageCountFallback');
	const pages = typeof raw?.pages === 'number' && raw.pages > 0 ? raw.pages : typeof fallback === 'number' ? fallback : null;
	const paths = bundlePathIndex(a.store, version.id);
	const src = vc.text('caselines_tab', 'url');
	const bundle = resolveLocator(paths, src, null);
	// a query over MAX_QUERY is refused visibly (qTooLong), never cut and searched
	const qRaw = url.searchParams.get('q') ?? '';
	const qTooLong = qRaw.length > MAX_QUERY;
	const q = qTooLong ? '' : qRaw;
	const hits = q.trim() && index.length ? searchPages(index, q) : null;
	const links = a.userWork.listRows(version.caseId, LINKS)
		.map((r) => ({ rowId: r.rowId, path: String(r.fields.path ?? ''), seq: Number(r.fields.seq) || 0 }))
		.sort((x, y) => x.seq - y.seq || (x.rowId < y.rowId ? -1 : 1))
		.map((l) => ({ ...l, name: linkedName(l.path), ref: paths.get(l.path) ?? null }));
	return {
		content: {
			subtitle: viewText(vc, 'caselines_tab', 'subtitle'),
			name: viewText(vc, 'caselines_tab', 'bundleName'),
			note: pages === null ? null : viewText(vc, 'caselines_tab', 'heroNote', { pages: pages.toLocaleString('en') }),
		},
		present: raw !== null,
		pages,
		bundle,
		cover: coverage(index, pages),
		q,
		qTooLong,
		// the original's download link (attachment, nosniff, sandbox CSP from the originals site) per served ref
		downloads: Object.fromEntries(await bundleDownloads(version.id, [...(bundle ? [bundle.ref] : []), ...links.flatMap((l) => (l.ref ? [l.ref] : []))])),
		search: hits ? { total: hits.length, occurrences: hits.reduce((n, h) => n + h.count, 0), hits: hits.slice(0, MAX_SHOWN) } : null,
		links,
	};
};

export const actions: Actions = {
	link: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const raw = String((await request.formData()).get('path') ?? '');
		const path = linkedPath(raw);
		if (!path) return { saved: false };
		if (path.length > 2048 || locatorPath(encode(path)) !== path) return fail(400, { message: 'Not linked: give a path inside the case folder, such as Folder/File.pdf.', values: { path: raw } });
		return guarded({ path: raw }, async () => { await addLink(v.case_id, path); return { saved: true }; });
	},
	unlink: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const id = String((await request.formData()).get('id') ?? '');
		// a link another tab already removed is gone either way: both intents agree
		return guarded({ id }, () => serial(v.case_id, LINKS, async () => ({ saved: await a.userWork.deleteRow(v.case_id, LINKS, id) })));
	},
};
