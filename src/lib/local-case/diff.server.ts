import type { CaseStore } from './store.server.ts';

export interface VersionDiff {
	base: string;
	candidate: string;
	documents: { base: number; candidate: number };
	unchanged: number;
	changedRows: { ref: string }[];
	renumbered: { from: string; to: string }[];
	added: string[];
	removed: string[];
	ambiguous: { sha256: string; base: string[]; candidate: string[] }[];
	unmatched: { base: number; candidate: number };
}

export function diffVersions(store: CaseStore, candidate: string, base: string): VersionDiff {
	const side = (vid: string) => {
		const rows = store.projectionRows(vid).documents;
		const sha = new Map(store.fingerprints(vid).map((f) => [f.ref, f.sha256]));
		const by = new Map<string, string[]>();
		let unmatched = 0;
		const rowOf = new Map(rows.map((r) => [r.ref, r.row_json]));
		for (const r of rows) {
			const s = sha.get(r.ref);
			if (!s) { unmatched++; continue; }
			by.set(s, [...(by.get(s) ?? []), r.ref]);
		}
		return { count: rows.length, by, unmatched, rowOf };
	};
	const B = side(base), C = side(candidate);
	const d: VersionDiff = { base, candidate, documents: { base: B.count, candidate: C.count }, unchanged: 0, changedRows: [], renumbered: [], added: [], removed: [], ambiguous: [], unmatched: { base: B.unmatched, candidate: C.unmatched } };
	for (const s of [...new Set([...B.by.keys(), ...C.by.keys()])].sort()) {
		const b = B.by.get(s) ?? [], c = C.by.get(s) ?? [];
		if (!b.length) { d.added.push(...c); continue; }
		if (!c.length) { d.removed.push(...b); continue; }
		if (b.length > 1 || c.length > 1) { d.ambiguous.push({ sha256: s, base: b.sort(), candidate: c.sort() }); continue; }
		if (b[0] !== c[0]) d.renumbered.push({ from: b[0]!, to: c[0]! });
		else if (B.rowOf.get(b[0]!) !== C.rowOf.get(c[0]!)) d.changedRows.push({ ref: c[0]! });
		else d.unchanged++;
	}
	d.added.sort(); d.removed.sort();
	return d;
}
