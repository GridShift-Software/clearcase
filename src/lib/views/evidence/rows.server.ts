import { documentRows, listJson } from '../../local-case/documents.server.ts';
import type { ChronologyListRow } from '../../local-case/model.ts';
import type { CaseStore } from '../../local-case/store.server.ts';

export interface EvidenceRows { rows: readonly ChronologyListRow[]; byRef: ReadonlyMap<string, ChronologyListRow>; failed: { source: string; owner: string; reason: string }[] }

const MAX = 8;
const cache = new Map<string, EvidenceRows>();

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

export interface SearchRows { rows: readonly (ChronologyListRow & { cc: string })[]; failed: EvidenceRows['failed'] }
const searchCache = new Map<string, SearchRows>();
export function searchRowsOf(store: CaseStore, resultsVersion: string): SearchRows | null {
	const l = listJson(store, resultsVersion);
	if (!l) return null;
	const key = `${resultsVersion}\0${l.etag}`;
	let hit = searchCache.get(key);
	if (!hit) {
		const cc = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v));
		const d = documentRows(store, resultsVersion);
		hit = { rows: Object.freeze(d.rows.map((x) => ({ ...x.list, cc: cc(x.row.cc) }))), failed: l.failed };
		if (searchCache.size >= MAX) searchCache.delete(searchCache.keys().next().value!);
		searchCache.set(key, hit);
	}
	return hit;
}
