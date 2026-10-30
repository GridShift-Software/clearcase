// Links from the bundle datasets (schedule files, bundle parts, the CaseLines source) to documents of the version and
// to its package files (GRS-45: bundle, index, extract, part and schedule files outside the register, verified as P-
// assets). A v5 locator resolves only when its decoded path is exactly the indexed path of a document row or of a
// package file that is verified and on disk now. Anything else is shown as text marked "not in the verified index;
// not served". No fuzzy matching, and item keys such as OD-10 are never refs (S-catalogue-refs). Browser-safe.
import { decodeLegacyLocator } from '../../case-package/paths.ts';
import { isPathKey } from '../../case-package/refs.ts';
import { documentRoute } from '../../case-package/render.ts';
import { viewerPageHref } from '../../viewer/hosted/page-link.ts';

export const NOT_SERVED = 'not in the verified index; not served';

export interface IndexedRow { ref: string; ord: number; originalPath: string | null; url: string | null }

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

export const locatorPath = (url: unknown): string | null => {
	if (typeof url !== 'string') return null;
	const d = decodeLegacyLocator(url);
	return d.ok && !d.directory ? d.path : null;
};

export const fragmentPage = (url: unknown): number | null => {
	if (typeof url !== 'string') return null;
	const d = decodeLegacyLocator(url);
	const m = d.ok && d.fragment ? /^page=(\d{1,7})$/.exec(d.fragment) : null;
	return m && +m[1]! >= 1 ? +m[1]! : null;
};

export interface Resolved { ref: string; page: number | null }

export function resolveLocator(index: ReadonlyMap<string, string>, url: unknown, page: number | null = fragmentPage(url)): Resolved | null {
	const path = locatorPath(url);
	const ref = path === null ? undefined : index.get(path);
	return ref === undefined ? null : { ref, page };
}

export function hrefOf(vid: string, files: Readonly<Record<string, string>>, r: Resolved | null, page: number | null = r?.page ?? null): string | null {
	if (!r) return null;
	if (Object.hasOwn(files, r.ref)) return viewerPageHref(files[r.ref]!, page);
	return isPathKey(r.ref) ? null : documentRoute(vid, r.ref, page);
}
