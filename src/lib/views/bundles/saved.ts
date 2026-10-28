// A bundle saved from the Builder, shown from the save's answer (GRS-264). The save endpoint reads the stored custom
// bundles after its own write and answers with them; the Court Bundle page replaces its custom bundles with that list,
// in stored order, instead of loading its 665 KB of data again. The list is the store's, not the page's plus one, so
// a bundle another tab created or deleted is right in it, and saving one output twice lists it once.
import { customOf, toBundle, type Custom } from '../../bundles/builder.ts';
import type { Bundle } from './court.ts';
import type { Resolved } from './links.ts';
import { bundleUploadHeaders } from './upload.ts';

/** One stored custom bundle as the save answers with it: its items, whether a PDF is stored for it, and (hosted) its row version. */
export interface StoredBundle { id: string; custom: Custom; assembled: boolean; version?: string }

export interface BundleLink { file: Resolved | null; indexFile: Resolved | null; rows: { slice: Resolved | null; parts: (Resolved | null)[]; caselines: Resolved | null }[] }
export interface BundleLists { bundles: Bundle[]; links: BundleLink[]; files: Record<string, string>; downloads: Record<string, string> }

/** The stored rows (stored order) as the save answers with them; for the endpoints. */
export const storedBundles = (rows: readonly (Custom & { id: string; assembledSha256: string | null; version?: unknown })[]): StoredBundle[] =>
	rows.map((r) => ({
		id: r.id,
		custom: { no: r.no, name: r.name, pages: r.pages, indexPages: r.indexPages, filePages: r.filePages, note: r.note, rows: r.rows },
		assembled: !!r.assembledSha256,
		...(typeof r.version === 'string' && r.version ? { version: r.version } : {}),
	}));

/** `refused`: the endpoint answered no, so the PDF is not stored. `failed`: no answer could be read, so nothing is known. */
export type SaveResult =
	| { ok: true; no: string; bundles: StoredBundle[] | null }
	| { ok: false; kind: 'refused' | 'failed'; message: string };

export const assembledUrl = (pathname: string, id: string) => `${pathname.replace(/\/$/, '')}/assembled?id=${encodeURIComponent(id)}`;

/** The list in an answer, or null when the answer has none (the page then keeps the list it has). */
function listOf(v: unknown): StoredBundle[] | null {
	if (!Array.isArray(v)) return null;
	const out: StoredBundle[] = [];
	for (const s of v) {
		const custom = customOf(s?.custom);
		if (!custom || typeof s.id !== 'string') return null;
		out.push({ id: s.id, custom, assembled: s.assembled === true, ...(typeof s.version === 'string' ? { version: s.version } : {}) });
	}
	return out;
}

/** POSTs the assembled PDF with its item list to `<pathname>/assembled`. Never throws. */
export async function saveBundle(send: typeof fetch, pathname: string, id: string, pdf: Blob, entry: Omit<Custom, 'no'>): Promise<SaveResult> {
	try {
		const response = await send(pathname.replace(/\/$/, '') + '/assembled', { method: 'POST', headers: bundleUploadHeaders(id, entry), body: pdf });
		const data = await response.json();
		if (!response.ok) return { ok: false, kind: 'refused', message: data.message ?? 'Not saved. Retry.' };
		return { ok: true, no: String(data?.no ?? ''), bundles: listOf(data?.bundles) };
	} catch {
		return { ok: false, kind: 'failed', message: 'Not saved: the upload failed. Retry.' };
	}
}

/** `loaded` with its custom bundles (those with an id) replaced by `stored`, after the shipped ones, as the loaders list them. */
export function withStored<T extends BundleLists>(loaded: T, stored: readonly StoredBundle[], pathname: string): T {
	const shipped = loaded.bundles.flatMap((b, i) => (b.id === undefined ? [i] : []));
	const dropped = new Set(loaded.bundles.flatMap((b) => (b.id === undefined ? [] : [b.id])));
	const link = (s: StoredBundle): BundleLink => ({ file: s.assembled ? { ref: s.id, page: null } : null, indexFile: null, rows: s.custom.rows.map((r) => ({ slice: null, parts: r.parts.map(() => null), caselines: null })) });
	const kept = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !dropped.has(k)));
	const stored_ = Object.fromEntries(stored.filter((s) => s.assembled).map((s) => [s.id, assembledUrl(pathname, s.id)]));
	return {
		...loaded,
		bundles: [...shipped.map((i) => loaded.bundles[i]!), ...stored.map((s) => toBundle(s.custom, s.id))],
		links: [...shipped.map((i) => loaded.links[i]!), ...stored.map(link)],
		files: { ...kept(loaded.files), ...stored_ },
		downloads: { ...kept(loaded.downloads), ...stored_ },
	};
}
