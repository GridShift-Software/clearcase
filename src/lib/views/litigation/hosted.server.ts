// The entry actions of Litigation and Quantum on the hosted app (sprint ticket 17b): `hostedCtx` is the `Ctx` the shared
// actions (`actions.server.ts`) run over, built on the user-work adapter's `hostedWork`. Each write is one `putRow`,
// `deleteRow` or `putSeedOverlay`, which is one D1 batch with its audit, and carries the version of the row it replaces, so a
// change made elsewhere is refused (409) and never overwritten. An operation id is derived from the request, so a retry of one
// submission is one write and a changed one is a new write.
import { createHash } from 'node:crypto';
import { error, isHttpError } from '@sveltejs/kit';
import { viewSeeds, type SeedOverlay, type SeedRow, type SeedView } from '../../case-package/user-work.ts';
import type { CaseId, RequestServices, ResultsVersion, Versioned, WorkRegisterRow } from '../../server/runtime/contracts.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id, resultsVersion } from '../../server/runtime/ids.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { shard } from '../hosted/payloads.server.ts';
import { guarded, hostedWork } from '../hosted/work-adapter.server.ts';
import type { EnforcementCtx } from './actions.server.ts';
import { STORES, type Ctx, type CtxOf, type Entries, type Fields, type Guard } from './answers.server.ts';
import { CX_SEED } from './crossexam.ts';
import { enforcementMerge, stepRows, stepVersion } from './enforcement.ts';
import type { VersionedRow } from '../../local-case/registers.server.ts';
import type { EnforcementShard } from './enforcement.ts';

type Params = Partial<Record<string, string>>;
type Event = { locals: RequestServices; params: Params };

/** The case and version a write names, from the URL alone: the store authorizes the case itself, so a write waits on no publication lookup. */
export function writeScope(params: Params): { caseId: CaseId; resultsVersion: ResultsVersion } {
	try { return { caseId: id('case', params.caseId ?? ''), resultsVersion: resultsVersion(params.version ?? '') }; }
	catch { error(404, { message: 'Not found.', code: 'not-found' }); }
}

/** An operation id from what the write is: the same request is the same operation, a changed one is a new operation. */
export const operationOf = (kind: string, ...parts: readonly unknown[]) => `17b.${kind}.${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48)}`;

/** The conflict a store answered, if it did: the row is not the version the page showed, or it is gone. */
export const conflictOf = (e: unknown): 'stale' | 'gone' | null => { const c = codeOf(e); return c === 'stale' || c === 'gone' ? c : null; };

/** The status a failed hosted write answers with: a refusal of authority is the refusal itself, a conflict 409, a busy store 503, anything else 500. */
export function statusOf(e: unknown): 503 | 409 | 500 {
	if (isDenial(e)) refuse(e, 'write');
	if (conflictOf(e)) return 409;
	const code = codeOf(e);
	return (isHttpError(e) && e.status === 503) || ['storage-unavailable', 'audit-unavailable', 'identity-unavailable', 'busy'].includes(code ?? '') ? 503 : 500;
}

/** The adapter's `guarded` with no `Work` argument: the writes here close over their own, so it answers in the local `Guard`'s shape. */
export const hostedGuard = guarded as unknown as Guard;

/** A register's rows in the order the local pages read them (seq, then creation), as the pure mergers take them. */
export function registerRows(rows: readonly Versioned<WorkRegisterRow>[]) {
	const seq = (r: WorkRegisterRow) => typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER;
	const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
	return [...rows].sort((a, b) => seq(a) - seq(b) || compare(a.createdAt, b.createdAt) || compare(a.rowId, b.rowId))
		.map((r) => ({ ...r, anchor: r.anchor?.sha256 ? { ...r.anchor, sha256: r.anchor.sha256 } : null }));
}

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
/** The token a page shows for a seed, as the local register's: what the seed and the user's overlay over it are. */
export const seedVersion = (s: SeedView): string => digest(['seed', s.state === 'orphaned' ? null : s.seed.seedSha256, s.state === 'seed' ? null : [s.overlay.baseSeedSha256, s.overlay.fields]]);
/** The store's version of the overlay a seed view rests on: what a write over it must name, empty while the seed is as imported. */
const overlayVersion = (s: SeedView): string => ('overlay' in s ? (s.overlay as Partial<Versioned<SeedOverlay>>).version ?? '' : '');

/** The imported rows of the views that keep seed overlays: the register they are kept with, and the shard that holds the seeds. */
const SEEDED = { [CX_SEED]: { store: STORES.crossexam, shard: 'view/crossexam_tab.json' } } as const;

/** The seeds a view's shard holds with the user's overlays over them, each with the version a page shows. */
export function seedViewsOf(seeds: readonly SeedRow[], overlays: readonly Versioned<SeedOverlay>[]) {
	return viewSeeds(seeds, overlays).map((s) => ({ ...s, seedId: s.state === 'orphaned' ? s.overlay.seedId : s.seed.seedId, version: seedVersion(s) }));
}

export function hostedEntries({ locals, params }: Event): Entries {
	const { caseId, resultsVersion: rv } = writeScope(params);
	const run = async <T>(op: string, version: string, write: (w: ReturnType<typeof hostedWork>) => Promise<T>): Promise<T | 'stale' | 'gone'> => {
		try { return await write(hostedWork(locals, caseId, rv, { operationId: op, version })); }
		catch (e) { const c = conflictOf(e); if (c) return c; throw e; }
	};
	return {
		async add(store, fields, addId) {
			const operationId = addId ? operationOf('add', store, addId, fields) : crypto.randomUUID();
			return { rowId: await hostedWork(locals, caseId, rv, { operationId }).putRow(caseId, store, null, fields) };
		},
		// A delete that names no version is refused as changed, not run against the row as it is now: that would delete an edit the person never saw.
		async remove(store, rowId, version) {
			if (!version) return 'stale';
			const r = await run(operationOf('delete', store, rowId, version), version, (w) => w.deleteRow(caseId, store, rowId));
			return r === true || r === false ? (r ? 'deleted' : 'gone') : r;
		},
		async removeSeed(datasetKey, seedId, version) {
			const source = SEEDED[datasetKey as keyof typeof SEEDED];
			if (!source) throw new Error(`no seeds are kept for ${datasetKey}`);
			const [{ seeds }, work] = await Promise.all([
				shard<{ seeds: SeedRow[] }>(locals, params, source.shard),
				locals.userWork.readViewWork({ caseId, store: source.store, datasetKey }).catch((e: unknown) => refuse(e)),
			]);
			const view = seedViewsOf(seeds, work.overlays).find((s) => s.seedId === seedId);
			if (!view) return 'absent';
			if ((view.state === 'edited' || view.state === 'orphaned') && view.overlay.fields.deleted === true) return 'gone';
			if (!version || version !== view.version) return 'stale';
			const overlay = view.state === 'orphaned' ? view.overlay : { baseSeedSha256: view.seed.seedSha256 };
			const r = await run(crypto.randomUUID(), overlayVersion(view),
				(w) => w.putSeedOverlay({ caseId, datasetKey, seedId, baseSeedSha256: overlay.baseSeedSha256, fields: { deleted: true } }));
			return r === 'stale' || r === 'gone' ? r : 'deleted';
		},
	};
}

export const hostedCtx: CtxOf = (event): Ctx => ({ caseId: writeScope(event.params).caseId, entries: hostedEntries(event), guard: hostedGuard });

/** The Enforcement Roadmap's status save over the adapter: the step's saved status row, replaced against the version the page showed. */
export const hostedEnforcementCtx: CtxOf<EnforcementCtx> = (event) => {
	const { locals, params } = event;
	const { caseId, resultsVersion: rv } = writeScope(params);
	let saved: Promise<readonly Versioned<WorkRegisterRow>[]> | null = null;
	// one read of the store for the request; a write drops it, so the next answer shows the write
	const read = () => (saved ??= locals.userWork.readViewWork({ caseId, store: STORES.enforcement }).then((w) => w.rows).catch((e: unknown) => { saved = null; return refuse(e); }));
	return {
		caseId, entries: hostedEntries(event), guard: hostedGuard,
		async rows() {
			const [payload, rows] = await Promise.all([shard<EnforcementShard>(locals, params, 'view/enforcement_tab.json'), read()]);
			return enforcementMerge(payload, { rows: registerRows(rows) as unknown as VersionedRow[] }).rows;
		},
		async save(stepKey, status, version) {
			const mine = stepRows(registerRows(await read()) as unknown as VersionedRow[], stepKey);
			if (version !== null && stepVersion(mine) !== version) return 'stale';
			const keep = mine.at(-1);
			const fields: Fields = { stepKey, status };
			if (typeof keep?.fields.seq === 'number') fields.seq = keep.fields.seq;
			// A retry of a save the store made finds the step at a new version and is refused as changed: the operation id need not name it.
			const w = hostedWork(locals, caseId, rv, { operationId: crypto.randomUUID(), version: keep?.version ?? '' });
			saved = null;
			try { await w.putRow(caseId, STORES.enforcement, keep?.rowId ?? null, fields); }
			catch (e) { if (conflictOf(e)) return 'stale'; throw e; }
			return 'saved';
		},
	};
};
