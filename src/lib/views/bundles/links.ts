// Links from the bundle datasets (schedule files, bundle parts, the CaseLines source) to documents of the version.
// Originals outside the document index are never served: only chronology rows are package assets, so a v5 locator
// resolves only when its decoded path is exactly the indexed path of a document row. Anything else is shown as text
// marked "not in the verified index; not served". No fuzzy matching, and item keys such as OD-10 are never refs
// (S-catalogue-refs). Browser-safe.
import { decodeLegacyLocator } from '../../case-package/paths.ts';

export const NOT_SERVED = 'not in the verified index; not served';

/** One document row as the path index needs it. */
export interface IndexedRow { ref: string; ord: number; originalPath: string | null; url: string | null }

/** path -> ref, from the original's indexed path or else a decodable row locator; the lowest `ord` wins a shared path. */
export function pathIndex(rows: Iterable<IndexedRow>): Map<string, string> {
	const best = new Map<string, { ref: string; ord: number }>();
	for (const r of rows) {
		let path = r.originalPath;
		if (!path && typeof r.url === 'string') { const d = decodeLegacyLocator(r.url); if (d.ok) path = d.path; }
		if (!path) continue;
		const cur = best.get(path);
		if (!cur || r.ord < cur.ord) best.set(path, { ref: r.ref, ord: r.ord });
	}
	return new Map([...best].map(([p, v]) => [p, v.ref]));
}

/** The decoded path of a v5 locator, or null when it does not decode. */
export const locatorPath = (url: unknown): string | null => {
	if (typeof url !== 'string') return null;
	const d = decodeLegacyLocator(url);
	return d.ok && !d.directory ? d.path : null;
};

/** A page fragment ('page=N', N >= 1) of a v5 locator, or null. */
export const fragmentPage = (url: unknown): number | null => {
	if (typeof url !== 'string') return null;
	const d = decodeLegacyLocator(url);
	const m = d.ok && d.fragment ? /^page=(\d{1,7})$/.exec(d.fragment) : null;
	return m && +m[1]! >= 1 ? +m[1]! : null;
};

export interface Resolved { ref: string; page: number | null }

/** The document a locator names, by exact indexed path; `page` from its '#page=N' fragment. Null when not indexed. */
export function resolveLocator(index: ReadonlyMap<string, string>, url: unknown, page: number | null = fragmentPage(url)): Resolved | null {
	const path = locatorPath(url);
	const ref = path === null ? undefined : index.get(path);
	return ref === undefined ? null : { ref, page };
}
