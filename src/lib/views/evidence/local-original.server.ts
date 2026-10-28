// A document's own original for the local chronology's pane: the same links its document page offers (the isolated
// viewer, the original and a download, all on the originals site), or why there are none. The app cannot show the original
// in its own page: its CSP allows only blob: frames and same-origin fetches, and the originals site refuses to be framed.
import type { CaseStore } from '$lib/local-case/store.server';
import { documentRow } from '$lib/local-case/documents.server';
import type { OriginalLinks } from '$lib/local-case/model';
import type { LocalOriginal } from '$lib/local-case/chronology';
import { OriginalsServer } from '$lib/local-case/originals.server';

export const NO_LINKS: OriginalLinks = { presentation: null, open: null, download: null, viewer: null };
type Links = Pick<OriginalsServer, 'originalHref' | 'downloadHref' | 'viewerHref'>;

/** Null when `ref` is not a document of the version; its own original's links otherwise (none when it is not on disk). */
export async function localOriginal(store: CaseStore, o: Links, vid: string, ref: string, available = OriginalsServer.availability): Promise<LocalOriginal | null> {
	const r = documentRow(store, vid, ref);
	if (!r || r.source !== 'results') return null;
	const asset = store.assetForServe(vid, r.ref);
	if (!asset?.real_path || asset.size === null || (asset.status !== 'verified' && asset.status !== 'case-mismatch')) return { ref: r.ref, links: NO_LINKS, onDisk: null };
	const gone = await available({ ...asset, real_path: asset.real_path, size: asset.size });
	if (gone) return { ref: r.ref, links: NO_LINKS, onDisk: gone.reason };
	const name = asset.real_path.slice(asset.real_path.lastIndexOf('/') + 1);
	return { ref: r.ref, links: { presentation: OriginalsServer.presentation(asset), open: o.originalHref(vid, r.ref, name), download: o.downloadHref(vid, r.ref, name), viewer: o.viewerHref(vid, r.ref) }, onDisk: null };
}
