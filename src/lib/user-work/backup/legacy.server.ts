// The legacy import hook (GRS-20): where a v5 browser backup (ess_dcs_backup.json, an object of ess_dcs_* keys, as v5's
// "Export all state" writes it) enters ClearCase. GRS-20 ships the hook only; a key with no registered importer is
// recognised and reported, never written. Importers are registered per key (or group of keys) in v5-importers.server.ts
// (today: the court bundles, GRS-56); restore then hands each importer its keys' values.
//  * Keys: the 21 live v5 stores (V5_STORES), v5's four keys no v5 code used (V5_LEGACY_KEYS: ess_dcs_courtbundle_v1,
//    ess_dcs_bundle_header_v1, ess_dcs_bundle_extents_v1, ess_dcs_bundle_overrides_v1), and any other ess_dcs_* key
//    (reported as unknown, never imported unless an importer claims it).
//  * A null value is an unused store (v5 writes null for those) and is skipped, as v5's own import skips it.
//  * Importers run one at a time, after a copy of the work (`copyFirst`: a work.sqlite backup and a JSON copy, which
//    refuses the import when it cannot be made); each must write all of its keys or none (one
//    transaction). One that throws stops the import and the result says which keys were imported before it.
import type { LocalCase } from '../../local-case/service.server.ts';
import { V5_KEY, V5_LEGACY_KEYS, V5_STORES } from './v5-keys.ts';

export interface LegacyContext { lc: LocalCase; caseId: string; resultsVersion: string }
export interface LegacyImporter {
	/** stable id, e.g. 'v5-registers' */
	id: string;
	/** owning Linear issue */
	owner: string;
	/** the v5 keys it imports */
	keys: readonly string[];
	/** write the values of its keys present in the file (all or nothing); returns how many rows it wrote */
	import(ctx: LegacyContext, values: Readonly<Record<string, unknown>>): Promise<{ rows: number }>;
}
export type LegacyKeyStatus = 'imported' | 'empty' | 'no-importer' | 'legacy-unused' | 'unknown' | 'failed' | 'not-run';
export interface LegacyResult {
	/** whether any importer wrote anything */
	changed: boolean;
	keys: { key: string; status: LegacyKeyStatus; importer: string | null }[];
	rows: number;
	error: string | null;
	/** the JSON copy of the work taken before any importer ran (null when none ran) */
	preRestore: string | null;
}

const importers = new Map<string, LegacyImporter>();
/** Register an importer (once per id; a key belongs to one importer). Returns an unregister function. */
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

/** Whether a parsed file is a v5 browser backup: a non-empty object whose keys are all v5 store keys. */
export function legacyBackup(o: unknown): o is Record<string, unknown> {
	if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
	const keys = Object.keys(o);
	return keys.length > 0 && keys.every((k) => V5_KEY.test(k));
}

const LIVE = new Set(V5_STORES.map((s) => s.key));
const LEGACY = new Set(V5_LEGACY_KEYS);

/** Hand a v5 backup to the registered importers. With none registered for its keys, nothing is written. */
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
