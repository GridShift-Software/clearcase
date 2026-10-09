// Read access to a stored results version's datasets for views (the M2 contract): the typed `data` of a recognized
// dataset, parsed strictly from the exact package bytes stored at import, mirroring GRS-10 readCandidate().dataset():
// unknown, opaque and residual datasets are never handed to views. Callers verify the version first (the
// /v/[vid] layout does: a version that fails verification never reaches a view). Results are immutable, so parsed
// values are cached per (version, key) and deep-frozen.
import { decodeUtf8Strict, parseStrictJson } from '../case-package/index.ts';
import { KNOWN_SCHEMAS } from '../case-package/registry.ts';
import type { CaseStore } from './store.server.ts';

const MAX_CACHED = 64;
const cache = new Map<string, unknown>();

function deepFreeze<T>(v: T): T {
	if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); }
	return v;
}

/** The `data` of dataset `key` in version `resultsVersion`, or null when absent or not a recognized schema. */
export function datasetOf<T = unknown>(store: CaseStore, resultsVersion: string, key: string): T | null {
	const id = `${resultsVersion}\0${key}`;
	if (cache.has(id)) return cache.get(id) as T | null;
	const row = store.storage.db().prepare('SELECT bytes FROM package_file WHERE version_id = ? AND path = ?').get(resultsVersion, `datasets/${key}.json`) as { bytes: Uint8Array } | undefined;
	let out: unknown = null;
	if (row) {
		const env = parseStrictJson(decodeUtf8Strict(new Uint8Array(row.bytes))) as { key?: unknown; schema?: unknown; data?: unknown };
		if (env.key === key && typeof env.schema === 'string' && KNOWN_SCHEMAS.has(env.schema)) out = deepFreeze(env.data);
	}
	if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
	cache.set(id, out);
	return out as T | null;
}

/** Keys of the datasets stored for a version (recognized or not; only recognized ones are readable). */
export function datasetKeys(store: CaseStore, resultsVersion: string): string[] {
	return (store.storage.db().prepare("SELECT path FROM package_file WHERE version_id = ? AND path LIKE 'datasets/%.json' ORDER BY path").all(resultsVersion) as { path: string }[])
		.map((r) => r.path.slice('datasets/'.length, -'.json'.length));
}
