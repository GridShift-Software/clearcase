
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

export const sizeLabel = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('en')} KB`;

/** A session upload's link (CC-09-r2 D1): an object URL of an application/octet-stream copy of the file, never of the
 *  file's own type, so the browser only ever downloads it and never renders it on the app origin. */
export const uploadBlob = (f: Blob) => new Blob([f], { type: 'application/octet-stream' });
export const uploadUrl = (f: Blob) => URL.createObjectURL(uploadBlob(f));
