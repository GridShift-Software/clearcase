import { decodeUtf8Strict, parseStrictJson } from '../case-package/index.ts';
import { KNOWN_SCHEMAS } from '../case-package/registry.ts';
import { readViewContent, VIEW_CONTENT_KEY, type ViewContentReader } from '../case-package/view-content.ts';
import type { CaseStore } from './store.server.ts';

const MAX_CACHED = 64;
const cache = new Map<string, unknown>();

function deepFreeze<T>(v: T): T {
	if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); }
	return v;
}

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

export function datasetKeys(store: CaseStore, resultsVersion: string): string[] {
	return (store.storage.db().prepare("SELECT path FROM package_file WHERE version_id = ? AND path LIKE 'datasets/%.json' ORDER BY path").all(resultsVersion) as { path: string }[])
		.map((r) => r.path.slice('datasets/'.length, -'.json'.length));
}

export const viewContentOf = (store: CaseStore, resultsVersion: string): ViewContentReader => readViewContent(datasetOf(store, resultsVersion, VIEW_CONTENT_KEY));

export function viewText(vc: ViewContentReader, view: string, field: string, params: Readonly<Record<string, string | number>> = {}): string | null {
	const f = vc.fill(view, field, params);
	return f && f.missing.length === 0 && f.text.trim() ? f.text : null;
}

export const EXPORT_NAME_NOTE = 'The results package names no export file for this view, so a generic file name is used.';
export const EXPORT_COLUMNS_NOTE = 'The results package names no export columns for this view, so generic column names are used.';

const UNSAFE_NAME = /[/\\\p{Cc}\p{Cf}]/u;
const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : null; };

export function exportFileName(vc: ViewContentReader, view: string, neutral: string, field = 'exportFileName'): { name: string; note: string | null } {
	const v = vc.text(view, field);
	const ok = v !== null && !UNSAFE_NAME.test(v) && !v.startsWith('.') && !v.includes('..') && v.trim() === v && [...v].length <= 128 &&
		extOf(v) !== null && extOf(v) === extOf(neutral);
	return ok ? { name: v, note: null } : { name: neutral, note: EXPORT_NAME_NOTE };
}

const UNSAFE_KEY = /^[=+\-@]|[\p{Cc}\p{Cf},"']/u;

export function exportColumns(vc: ViewContentReader, view: string, neutral: readonly string[], field = 'exportColumns'): { keys: string[]; note: string | null } {
	const v = vc.list(view, field);
	const ok = v !== null && v.length === neutral.length && new Set(v).size === v.length && v.every((k) => k.length >= 1 && [...k].length <= 64 && !UNSAFE_KEY.test(k));
	return ok ? { keys: v, note: null } : { keys: [...neutral], note: EXPORT_COLUMNS_NOTE };
}
