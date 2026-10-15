import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { SeedView } from '../case-package/browser.ts';
import type { RegisterRow, RegisterValue, UserWork } from './user-work.server.ts';

export type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow' | 'seedViews' | 'putSeedOverlay'>;
export type Fields = Record<string, RegisterValue>;
export type VersionedRow = RegisterRow & { version: string };
export type VersionedSeed = SeedView & { seedId: string; version: string };
export type AddResult = { rowId: string; repeated: boolean };
export type ReplaceResult = 'replaced' | 'gone' | 'stale';
export type DeleteResult = 'deleted' | 'gone' | 'stale';

export interface RegisterTx {
	rows(): VersionedRow[];
	add(fields: Fields, opts?: { addId?: string | null }): Promise<AddResult>;
	replace(rowId: string, version: string | null, fields: Fields): Promise<ReplaceResult>;
	remove(rowId: string, version: string | null): Promise<DeleteResult>;
}
export interface RegisterStore extends RegisterTx {
	batch<T>(fn: (tx: RegisterTx) => Promise<T>): Promise<T>;
}
export interface SeedStore {
	views(): VersionedSeed[];
	remove(seedId: string, version: string | null): Promise<DeleteResult | 'absent'>;
}
export interface Registers {
	open(caseId: string, store: string): RegisterStore;
	seeds(caseId: string, resultsVersion: string, datasetKey: string): SeedStore;
	exclusive<T>(caseId: string, fn: () => Promise<T>): Promise<T>;
}

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const seqOf = (r: RegisterRow): number | null => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : null);
const nextSeq = (rows: readonly RegisterRow[]) => rows.reduce((m, r) => Math.max(m, seqOf(r) ?? 0), 0) + 1;
const inOrder = (a: RegisterRow, b: RegisterRow) => (seqOf(a) ?? Number.MAX_SAFE_INTEGER) - (seqOf(b) ?? Number.MAX_SAFE_INTEGER) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);
const rowVersion = (fields: Fields) => digest(['row', fields]);
const seedIdOf = (v: SeedView) => (v.state === 'orphaned' ? v.overlay.seedId : v.seed.seedId);
const seedVersion = (v: SeedView) => digest(['seed', v.state === 'orphaned' ? null : v.seed.seedSha256, v.state === 'seed' ? null : [v.overlay.baseSeedSha256, v.overlay.fields]]);
const isDeleted = (f: Readonly<Record<string, unknown>>) => f.deleted === true;


const DONE: Promise<unknown> = Promise.resolve();
type Held = { w: object; caseId: string; store: string | null; tail: Promise<unknown>; done: boolean; up: Held | undefined };
const holding = new AsyncLocalStorage<Held>();
const NOOP = () => undefined;
type CaseQueue = { all: Promise<unknown>; stores: Map<string, Promise<unknown>> };
const queues = new WeakMap<object, Map<string, CaseQueue>>();

async function step<T>(h: Held, fn: () => Promise<T>): Promise<T> {
	try { return await holding.run(h, fn); } finally { h.done = true; }
}

function queued<T>(w: object, caseId: string, store: string | null, fn: () => Promise<T>): Promise<T> {
	let open = holding.getStore();
	while (open?.done) open = open.up;
	const held = open;
	if (held && held.w === w && held.caseId === caseId) {
		if (held.store !== null && held.store !== store) return Promise.reject(new Error(`register store: ${store === null ? 'an exclusive run' : `a write to store "${store.replace(/\0.*/s, '')}"`} inside a batch of store "${held.store}" would wait on that batch; take the exclusive run around it, or write after the batch`));
		const run = held.tail.then(() => step({ ...held, tail: DONE, done: false, up: held }, fn));
		held.tail = run.then(NOOP, NOOP);
		return run;
	}
	let cases = queues.get(w);
	if (!cases) queues.set(w, (cases = new Map()));
	let q = cases.get(caseId);
	if (!q) cases.set(caseId, (q = { all: DONE, stores: new Map() }));
	const run = Promise.all(store === null ? [q.all, ...q.stores.values()] : [q.all, q.stores.get(store) ?? DONE]).then(() => step({ w, caseId, store, tail: DONE, done: false, up: undefined }, fn));
	const settled = run.then(() => undefined, () => undefined);
	if (store === null) q.all = settled; else q.stores.set(store, settled);
	const cq = q, cs = cases;
	void settled.then(() => {
		if (store === null) { if (cq.all === settled) cq.all = DONE; } else if (cq.stores.get(store) === settled) cq.stores.delete(store);
		if (cq.all === DONE && cq.stores.size === 0 && cs.get(caseId) === cq) cs.delete(caseId);
	});
	return run;
}

export const inTurn = <T>(w: object, caseId: string, key: string, fn: () => Promise<T>): Promise<T> => queued(w, caseId, key, fn);

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
