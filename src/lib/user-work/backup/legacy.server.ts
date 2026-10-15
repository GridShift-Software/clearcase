import type { LocalCase } from '../../local-case/service.server.ts';
import { V5_KEY, V5_LEGACY_KEYS, V5_STORES } from './v5-keys.ts';

export interface LegacyContext { lc: LocalCase; caseId: string; resultsVersion: string }
export interface LegacyImporter {
	id: string;
	owner: string;
	keys: readonly string[];
	import(ctx: LegacyContext, values: Readonly<Record<string, unknown>>): Promise<{ rows: number }>;
}
export type LegacyKeyStatus = 'imported' | 'empty' | 'no-importer' | 'legacy-unused' | 'unknown' | 'failed' | 'not-run';
export interface LegacyResult {
	changed: boolean;
	keys: { key: string; status: LegacyKeyStatus; importer: string | null }[];
	rows: number;
	error: string | null;
	preRestore: string | null;
}

const importers = new Map<string, LegacyImporter>();
export function registerLegacyImporter(imp: LegacyImporter): () => void {
	if (importers.has(imp.id)) throw new Error(`legacy importer ${imp.id} is already registered`);
	for (const k of imp.keys) {
		if (!V5_KEY.test(k)) throw new Error(`legacy importer ${imp.id}: ${k} is not a v5 store key`);
		const other = [...importers.values()].find((x) => x.keys.includes(k));
		if (other) throw new Error(`legacy importer ${imp.id}: ${k} is imported by ${other.id}`);
	}
	importers.set(imp.id, imp);
	return () => { if (importers.get(imp.id) === imp) importers.delete(imp.id); };
}
export const legacyImporters = (): { id: string; owner: string; keys: readonly string[] }[] => [...importers.values()].map((i) => ({ id: i.id, owner: i.owner, keys: i.keys }));

export function legacyBackup(o: unknown): o is Record<string, unknown> {
	if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
	const keys = Object.keys(o);
	return keys.length > 0 && keys.every((k) => V5_KEY.test(k));
}

const LIVE = new Set(V5_STORES.map((s) => s.key));
const LEGACY = new Set(V5_LEGACY_KEYS);

export async function importLegacy(lc: LocalCase, o: Record<string, unknown>, active: { caseId: string; resultsVersion: string }, copyFirst: () => string): Promise<LegacyResult> {
	const keys: LegacyResult['keys'] = [];
	const plan = new Map<LegacyImporter, string[]>();
	for (const key of Object.keys(o).sort()) {
		const imp = [...importers.values()].find((x) => x.keys.includes(key)) ?? null;
		if (o[key] === null || o[key] === undefined) keys.push({ key, status: 'empty', importer: null });
		else if (imp) { keys.push({ key, status: 'not-run', importer: imp.id }); plan.set(imp, [...(plan.get(imp) ?? []), key]); }
		else keys.push({ key, status: LEGACY.has(key) ? 'legacy-unused' : LIVE.has(key) ? 'no-importer' : 'unknown', importer: null });
	}
	const result: LegacyResult = { changed: false, keys, rows: 0, error: null, preRestore: null };
	if (!plan.size) return result;
	result.preRestore = copyFirst();
	for (const [imp, ks] of plan) {
		try {
			const r = await imp.import({ lc, caseId: active.caseId, resultsVersion: active.resultsVersion }, Object.freeze(Object.fromEntries(ks.map((k) => [k, o[k]]))));
			result.rows += r.rows;
			result.changed ||= r.rows > 0;
			for (const k of keys) if (ks.includes(k.key)) k.status = 'imported';
		} catch (e) {
			for (const k of keys) if (ks.includes(k.key)) k.status = 'failed';
			result.error = `${imp.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
			break;
		}
	}
	return result;
}
