// The evidence views' read of document rows: the document-row contract's list (`listJson`, the imported register
// plus provider rows, exactly as the chronology API serves it), parsed once per list ETag. The ETag changes whenever a
// provider's revision does, so rescanned rows (GRS-20) flow through every evidence view without a change here.
import { listJson } from '../../local-case/documents.server.ts';
import type { ChronologyListRow } from '../../local-case/model.ts';
import type { CaseStore } from '../../local-case/store.server.ts';

export interface EvidenceRows { rows: readonly ChronologyListRow[]; byRef: ReadonlyMap<string, ChronologyListRow>; failed: { source: string; owner: string; reason: string }[] }

const MAX = 8;
const cache = new Map<string, EvidenceRows>();

/** Every document row of a version in contract order, with a by-ref index; null for an unknown version. */
export function evidenceRows(store: CaseStore, resultsVersion: string): EvidenceRows | null {
	const l = listJson(store, resultsVersion);
	if (!l) return null;
	const key = `${resultsVersion}\0${l.etag}`;
	let hit = cache.get(key);
	if (!hit) {
		const rows = Object.freeze(JSON.parse(l.json) as ChronologyListRow[]);
		hit = { rows, byRef: new Map(rows.map((r) => [r.ref, r])), failed: l.failed };
		if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
		cache.set(key, hit);
	}
	return hit;
}
