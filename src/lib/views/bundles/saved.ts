// A bundle saved from the Builder, shown from the save's answer (GRS-264). The save endpoint answers with the new bundle's
// number; the Builder already holds the rest, so the Court Bundle page adds the bundle to its lists without loading its
// 665 KB of data again. The next load of the page carries the stored bundle, and the overlay then yields to it.
import { toBundle, type Custom } from '../../bundles/builder.ts';
import type { Bundle } from './court.ts';
import type { Resolved } from './links.ts';
import { bundleUploadHeaders } from './upload.ts';

export interface SavedBundle { id: string; custom: Custom }

export interface BundleLink { file: Resolved | null; indexFile: Resolved | null; rows: { slice: Resolved | null; parts: (Resolved | null)[]; caselines: Resolved | null }[] }
export interface BundleLists { bundles: Bundle[]; links: BundleLink[]; files: Record<string, string>; downloads: Record<string, string> }

/** `refused`: the endpoint answered no, so the PDF is not stored. `failed`: no answer could be read, so nothing is known. */
export type SaveResult = { ok: true; saved: SavedBundle } | { ok: false; kind: 'refused' | 'failed'; message: string };

export const assembledUrl = (pathname: string, id: string) => `${pathname.replace(/\/$/, '')}/assembled?id=${encodeURIComponent(id)}`;

/** POSTs the assembled PDF with its item list to `<pathname>/assembled`. Never throws. */
export async function saveBundle(send: typeof fetch, pathname: string, id: string, pdf: Blob, entry: Omit<Custom, 'no'>): Promise<SaveResult> {
	try {
		const response = await send(pathname.replace(/\/$/, '') + '/assembled', { method: 'POST', headers: bundleUploadHeaders(id, entry), body: pdf });
		const data = await response.json();
		if (!response.ok) return { ok: false, kind: 'refused', message: data.message ?? 'Not saved. Retry.' };
		return { ok: true, saved: { id, custom: { ...entry, no: String(data?.no ?? '') } } };
	} catch {
		return { ok: false, kind: 'failed', message: 'Not saved: the upload failed. Retry.' };
	}
}

/** `loaded` with the saved bundles it does not carry yet appended, in the order saved. Returns `loaded` itself when there are none. */
export function withSaved<T extends BundleLists>(loaded: T, saved: readonly SavedBundle[], pathname: string): T {
	const fresh = saved.filter((s) => !loaded.bundles.some((b) => b.id === s.id));
	if (!fresh.length) return loaded;
	const link = (id: string) => assembledUrl(pathname, id);
	return {
		...loaded,
		bundles: [...loaded.bundles, ...fresh.map((s) => toBundle(s.custom, s.id))],
		links: [...loaded.links, ...fresh.map((s): BundleLink => ({ file: { ref: s.id, page: null }, indexFile: null, rows: s.custom.rows.map((r) => ({ slice: null, parts: r.parts.map(() => null), caselines: null })) }))],
		files: { ...loaded.files, ...Object.fromEntries(fresh.map((s) => [s.id, link(s.id)])) },
		downloads: { ...loaded.downloads, ...Object.fromEntries(fresh.map((s) => [s.id, link(s.id)])) },
	};
}
