// The version's path -> ref index for bundle links, from the document-row contract (imported rows and providers), and
// the package files the bundle views link (GRS-45).
import { app, originals } from '../../local-case/app.server.ts';
import { documentRows } from '../../local-case/documents.server.ts';
import { OriginalsServer } from '../../local-case/originals.server.ts';
import type { AssetServeRow, CaseStore } from '../../local-case/store.server.ts';
import { pathIndex } from './links.ts';

export function bundlePathIndex(store: CaseStore, resultsVersion: string): Map<string, string> {
	return pathIndex(documentRows(store, resultsVersion).rows.map((r) => ({ ref: r.ref, ord: r.ord, originalPath: r.state.original?.path ?? null, url: typeof r.row.url === 'string' ? r.row.url : null })));
}

/** A verified original that is on disk now (existence, case folder, links and size; the serve path re-hashes). */
async function servable(asset: AssetServeRow | undefined): Promise<boolean> {
	if (!asset?.real_path || asset.size === null || (asset.status !== 'verified' && asset.status !== 'case-mismatch')) return false;
	return (await OriginalsServer.availability({ ...asset, real_path: asset.real_path, size: asset.size })) === null;
}

/**
 * The bundle views' links (GRS-45): `paths` maps a locator path to a document ref, or to the key of a package file
 * (bundle, index, extract, part or schedule file) that is servable now; `files` maps each such key to where it opens
 * on the originals site (the PDF viewer, else the original). A package file that is missing, refused or gone from
 * disk is in neither, so its link shows as not served. A document path wins over a package file's.
 */
export async function bundleLinks(store: CaseStore, vid: string): Promise<{ paths: Map<string, string>; files: Record<string, string> }> {
	const paths = bundlePathIndex(store, vid), o = originals(), files: Record<string, string> = {};
	await Promise.all(store.packageFileAssets(vid).map(async (f) => {
		if (paths.has(f.indexed_path) || !(await servable(f))) return;
		paths.set(f.indexed_path, f.key);
		files[f.key] = OriginalsServer.presentation(f) === 'viewer' && o.pdfjs ? o.viewerHref(vid, f.key) : o.originalHref(vid, f.key, f.real_path!.slice(f.real_path!.lastIndexOf('/') + 1));
	}));
	return { paths, files };
}

/**
 * ref -> the original's download link, as the document page computes `#download-original`: a verified original that
 * is on disk now, served by the originals site with `download=1` (application/octet-stream, Content-Disposition:
 * attachment, nosniff, CSP sandbox). A ref without one is absent, and its "Download" is not offered.
 */
export async function bundleDownloads(vid: string, refs: Iterable<string>): Promise<Map<string, string>> {
	const a = app(), o = originals(), out = new Map<string, string>();
	await Promise.all([...new Set(refs)].map(async (ref) => {
		const asset = a.store.assetForServe(vid, ref);
		if (!(await servable(asset))) return;
		out.set(ref, o.downloadHref(vid, ref, asset!.real_path!.slice(asset!.real_path!.lastIndexOf('/') + 1)));
	}));
	return out;
}
