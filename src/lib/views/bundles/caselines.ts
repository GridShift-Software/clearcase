// CaseLines (v5 caselines_tab, L3513-3644): page-text search over the imported caselines-index, the coverage that
// search has (BA-08), and the v5 path normalisation of linked files. Pure; the server runs the search.

export type PageText = readonly [number, string];
export interface Hit { p: number; count: number; pre: string; mid: string; post: string }
export const MAX_SHOWN = 400;
export const MAX_QUERY = 200;

/** v5 snippet (L3593): 70 characters before and 90 after the first hit, offsets from the lower-cased text applied to
 *  the original (S-caselines_tab-5, low, copied). */
export function snippet(t: string, at: number, len: number): Pick<Hit, 'pre' | 'mid' | 'post'> {
	const s = Math.max(0, at - 70), e = Math.min(t.length, at + len + 90);
	return { pre: (s > 0 ? '… ' : '') + t.slice(s, at), mid: t.slice(at, at + len), post: t.slice(at + len, e) + (e < t.length ? ' …' : '') };
}

/** v5 doSearch (L3579): case-insensitive substring per page; the count stops once it exceeds 50; ascending pages. */
export function searchPages(index: readonly PageText[], query: string): Hit[] {
	const q = query.trim();
	if (!q) return [];
	const ql = q.toLowerCase();
	const res: Hit[] = [];
	for (const [p, t] of index) {
		const lo = t.toLowerCase();
		let hit = lo.indexOf(ql), count = 0, first = -1;
		while (hit >= 0) { count++; if (first < 0) first = hit; hit = lo.indexOf(ql, hit + ql.length); if (count > 50) break; }
		if (count) res.push({ p, count, ...snippet(t, first, q.length) });
	}
	return res.sort((a, b) => a.p - b.p);
}

/** What search covers (BA-08): the pages the index holds, those without text, and the bundle's page count. */
export function coverage(index: readonly PageText[], pages: number | null) {
	const empty = index.filter(([, t]) => !t.trim()).map(([p]) => p);
	return { indexed: index.length, withoutText: empty.length, emptyPages: empty.slice(0, 50), pages };
}

/** v5 linkPath (L3615): drop one leading '.' and leading slashes; the stored path is what v5's './' locator decodes
 *  to. Already-encoded input stays as typed (S-caselines_tab-4, low, copied); empty input is null. */
export function linkedPath(raw: string): string | null {
	const rel = raw.trim().replace(/^\.?\/*/, '');
	return rel ? rel : null;
}
export const linkedName = (path: string) => path.split('/').pop() || path;

/** Upload list size label (v5 L3634). */
export const sizeLabel = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('en')} KB`;
