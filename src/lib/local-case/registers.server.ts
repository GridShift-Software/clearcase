// The register store (GRS-52): every write of a user register (register_row rows of one case and store) and of a
// case's seed overlays goes through here. One in-process queue per (case, store) runs the writes one after another, so
// a write's `seq` is computed, and the row it targets re-read, just before its own putRow or deleteRow with no other
// write of that store in between, even while a busy store makes each write wait out its retries. A write against a
// stored row carries the version of the row as the page showed it (a hash of its stored fields, never updatedAt, which
// a fixed clock never changes): a row changed since is refused ('stale'), a row already gone is said ('gone') and never
// re-created. Rows are listed in insertion order, an explicit integer `seq` (listRows orders by createdAt, which ties
// under a fixed clock). `exclusive(caseId, fn)` runs `fn` after, and before, every queued write of the case: a restore
// that takes it cannot land between a write's re-check and its write.
//
// One server process serves a data directory (an exclusive instance lock). A write that bypasses this module (another
// process on the same directory, a restore that does not take `exclusive`) can still land between a re-check and its
// write's own transaction.
import { createHash } from 'node:crypto';
import type { SeedView } from '../case-package/browser.ts';
import type { RegisterRow, RegisterValue, UserWork } from './user-work.server.ts';

/** The user-work the store writes through (the app's userWork, or an in-memory adapter in tests). */
export type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow' | 'seedViews' | 'putSeedOverlay'>;
export type Fields = Record<string, RegisterValue>;
/** A stored row and its version, the value a page sends back with a write against it. */
export type VersionedRow = RegisterRow & { version: string };
/** A seed as the case shows it (seed, edited or orphaned), its id and its version. */
export type VersionedSeed = SeedView & { seedId: string; version: string };
export type AddResult = { rowId: string; repeated: boolean };
export type ReplaceResult = 'replaced' | 'gone' | 'stale';
export type DeleteResult = 'deleted' | 'gone' | 'stale';

/** One store's reads and writes. `version` null skips the re-check (a scripted post without one). */
export interface RegisterTx {
	/** The rows in insertion order, each with its version. */
	rows(): VersionedRow[];
	/** Store a row after the last (the next `seq`). A repeat of one form's post (same `addId` and fields) stores nothing and answers with the first row. */
	add(fields: Fields, opts?: { addId?: string | null }): Promise<AddResult>;
	/** Replace a row's fields, keeping its place (`seq`), when it is still at `version`. */
	replace(rowId: string, version: string | null, fields: Fields): Promise<ReplaceResult>;
	/** Delete a row when it is still at `version`. */
	remove(rowId: string, version: string | null): Promise<DeleteResult>;
}
export interface RegisterStore extends RegisterTx {
	/** Run several writes as one step of the queue: `fn`'s writes see each other, and no other write of the store lands in between. */
	batch<T>(fn: (tx: RegisterTx) => Promise<T>): Promise<T>;
}
export interface SeedStore {
	views(): VersionedSeed[];
	/** Delete an imported topic: an overlay `{deleted: true}` against its current content (results never change). 'absent': no such topic; 'gone': already deleted. */
	remove(seedId: string, version: string | null): Promise<DeleteResult | 'absent'>;
}
export interface Registers {
	open(caseId: string, store: string): RegisterStore;
	seeds(caseId: string, resultsVersion: string, datasetKey: string): SeedStore;
	/** Run `fn` once every queued write of the case has settled; the case's later writes wait until it settles. */
	exclusive<T>(caseId: string, fn: () => Promise<T>): Promise<T>;
}

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const seqOf = (r: RegisterRow): number | null => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : null);
const nextSeq = (rows: readonly RegisterRow[]) => rows.reduce((m, r) => Math.max(m, seqOf(r) ?? 0), 0) + 1;
const inOrder = (a: RegisterRow, b: RegisterRow) => (seqOf(a) ?? Number.MAX_SAFE_INTEGER) - (seqOf(b) ?? Number.MAX_SAFE_INTEGER) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);
const rowVersion = (fields: Fields) => digest(['row', fields]);
const seedIdOf = (v: SeedView) => (v.state === 'orphaned' ? v.overlay.seedId : v.seed.seedId);
const seedVersion = (v: SeedView) => digest(['seed', v.state === 'orphaned' ? null : v.seed.seedSha256, v.state === 'seed' ? null : [v.overlay.baseSeedSha256, v.overlay.fields]]);
// the overlay this module writes for a deleted seed (crossexam.ts isDeleted reads it)
const isDeleted = (f: Readonly<Record<string, unknown>>) => f.deleted === true;

// ---- the queue: per user-work, per case; a store's writes run in turn, an exclusive run alone ----------------------

const DONE: Promise<unknown> = Promise.resolve();
type CaseQueue = { all: Promise<unknown>; stores: Map<string, Promise<unknown>> };
const queues = new WeakMap<object, Map<string, CaseQueue>>();

/** Run `fn` after the case's earlier exclusive run and, for a store, its earlier writes (`store` null: after every earlier write of the case). A failure does not block later calls. */
function queued<T>(w: Work, caseId: string, store: string | null, fn: () => Promise<T>): Promise<T> {
	let cases = queues.get(w);
	if (!cases) queues.set(w, (cases = new Map()));
	let q = cases.get(caseId);
	if (!q) cases.set(caseId, (q = { all: DONE, stores: new Map() }));
	const run = Promise.all(store === null ? [q.all, ...q.stores.values()] : [q.all, q.stores.get(store) ?? DONE]).then(() => fn());
	const settled = run.then(() => undefined, () => undefined);
	if (store === null) q.all = settled; else q.stores.set(store, settled);
	const cq = q, cs = cases;
	void settled.then(() => {
		if (store === null) { if (cq.all === settled) cq.all = DONE; } else if (cq.stores.get(store) === settled) cq.stores.delete(store);
		if (cq.all === DONE && cq.stores.size === 0 && cs.get(caseId) === cq) cs.delete(caseId);
	});
	return run;
}

// Adds seen per user-work, by the form's one-time add id and the fields sent: a second post of the same form (a double
// press without JavaScript, a retry of a request that did arrive) answers with the row the first one stored.
const recent = new WeakMap<object, Map<string, string>>();
const RECENT_MAX = 500;

function tx(w: Work, caseId: string, store: string): RegisterTx {
	const rows = () => w.listRows(caseId, store).sort(inOrder).map((r) => ({ ...r, version: rowVersion(r.fields) }));
	const find = (rowId: string, version: string | null) => {
		const cur = w.listRows(caseId, store).find((r) => r.rowId === rowId);
		return !cur ? 'gone' : version !== null && rowVersion(cur.fields) !== version ? 'stale' : cur;
	};
	return {
		rows,
		async add(fields, { addId = null } = {}) {
			let seen = recent.get(w);
			if (!seen) recent.set(w, (seen = new Map()));
			const tag = addId ? digest([caseId, store, addId, fields]) : null;
			const prior = tag ? seen.get(tag) : undefined;
			if (prior && w.listRows(caseId, store).some((r) => r.rowId === prior)) return { rowId: prior, repeated: true };
			const rowId = await w.putRow(caseId, store, null, { ...fields, seq: nextSeq(w.listRows(caseId, store)) });
			if (tag) {
				seen.set(tag, rowId);
				if (seen.size > RECENT_MAX) seen.delete(seen.keys().next().value!);
			}
			return { rowId, repeated: false };
		},
		async replace(rowId, version, fields) {
			const cur = find(rowId, version);
			if (typeof cur === 'string') return cur;
			await w.putRow(caseId, store, rowId, { ...fields, seq: seqOf(cur) ?? nextSeq(w.listRows(caseId, store)) }, cur.anchor);
			return 'replaced';
		},
		async remove(rowId, version) {
			const cur = find(rowId, version);
			if (typeof cur === 'string') return cur;
			return (await w.deleteRow(caseId, store, rowId)) ? 'deleted' : 'gone';
		},
	};
}

/** The register store of a user-work. */
export function registers(w: Work): Registers {
	return {
		open(caseId, store) {
			const t = tx(w, caseId, store);
			const q = <T>(fn: () => Promise<T>) => queued(w, caseId, store, fn);
			return {
				rows: t.rows,
				add: (fields, opts) => q(() => t.add(fields, opts)),
				replace: (rowId, version, fields) => q(() => t.replace(rowId, version, fields)),
				remove: (rowId, version) => q(() => t.remove(rowId, version)),
				batch: (fn) => q(() => fn(t)),
			};
		},
		seeds(caseId, resultsVersion, datasetKey) {
			const views = () => w.seedViews(caseId, resultsVersion, datasetKey).map((v) => ({ ...v, seedId: seedIdOf(v), version: seedVersion(v) }));
			return {
				views,
				remove: (seedId, version) => queued(w, caseId, `seed\u0000${datasetKey}`, async () => {
					const sv = views().find((x) => x.seedId === seedId);
					if (!sv) return 'absent';
					if ((sv.state === 'edited' || sv.state === 'orphaned') && isDeleted(sv.overlay.fields)) return 'gone';
					if (version !== null && sv.version !== version) return 'stale';
					await w.putSeedOverlay({ caseId, datasetKey, seedId, baseSeedSha256: sv.state === 'orphaned' ? sv.overlay.baseSeedSha256 : sv.seed.seedSha256, fields: { deleted: true } });
					return 'deleted';
				}),
			};
		},
		exclusive: (caseId, fn) => queued(w, caseId, null, fn),
	};
}
