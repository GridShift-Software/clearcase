// User-work API over work.sqlite: notes, seed overlays and register rows. This is the shared persistence contract
// for M2 view owners: every row is keyed by a stable id (a UUID for notes and register rows, GRS-10's seed id for
// overlays), never by an array index or a display position, and lives outside the immutable results.
//  * Document anchors are {caseId, sha256, refAtCreation, resultsVersion} (GRS-10 DocumentAnchor). Inside the
//    version it was made in, an anchor names its ref (refs are package-local). In any other version it is matched by
//    fingerprint only (matchAnchor): exact, ambiguous (disclosed, several refs share the bytes) or missing (disclosed).
//    A document without a verified original has no fingerprint: its notes stay attached in their own version and are
//    disclosed as unanchored elsewhere. A ref alone never re-attaches work across versions.
//  * Seed overlays follow viewSeeds: seed, edited, conflict (the seed changed since the edit; both are shown) or
//    orphaned (the seed is gone; the edit is kept).
//  * Activation never writes here. Every write schedules a work.sqlite backup.
//  * Enumerable: tables() lists every work.sqlite table (from SQLite itself, labelled by work.userwork_catalog), and
//    exportAll()/importAll() round-trip them generically, including tables later tickets add with defineTable(). A
//    backup or restore feature never needs per-table code.
import { createHash, randomUUID } from 'node:crypto';
import { now } from '../components/clock.ts';
import { matchAnchor, viewSeeds, type DocumentAnchor, type SeedOverlay, type SeedRow, type SeedView } from '../case-package/index.ts';
import type { Storage } from './db.server.ts';
import type { CaseStore } from './store.server.ts';

export type AnchorStatus = 'here' | 'exact' | 'ambiguous' | 'missing' | 'unanchored';
export interface NoteView {
	id: string;
	body: string;
	createdAt: string;
	refAtCreation: string;
	resultsVersion: string;
	anchorSha256: string | null;
	/** here: made on this document in this version; exact: re-attached by fingerprint; ambiguous: several refs share it */
	status: AnchorStatus;
	/** refs sharing the fingerprint when ambiguous */
	candidates: string[];
	/** false when the stored body no longer matches the digest written with it */
	intact: boolean;
}
export interface NoteSummary { total: number; here: number; exact: number; ambiguous: number; missing: number; unanchored: number; byRef: { ref: string; n: number; status: AnchorStatus }[]; detached: NoteView[] }

export interface RegisterRow { rowId: string; store: string; anchor: DocumentAnchor | null; fields: Record<string, RegisterValue>; createdAt: string; updatedAt: string; intact: boolean }
export type RegisterValue = string | number | boolean | null;

const STORE = /^[a-z][a-z0-9-]{0,63}$/;
const TABLE = /^[a-z][a-z0-9_]{0,62}$/;
const COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB']);
/** SQLite reserves sqlite_*; ClearCase refuses the whole sqlite prefix for tables it defines or restores. */
const RESERVED = (name: string) => name.startsWith('sqlite') || name === 'userwork_catalog';
export const USER_WORK_EXPORT = 'clearcase.user-work/1';

export type TableKind = 'user-work' | 'activation' | 'unregistered';
export interface TableColumn { name: string; type: string; notNull: boolean; pk: number }
export interface UserWorkTable { name: string; kind: TableKind; owner: string; description: string; columns: TableColumn[] }
export interface TableDefinition { name: string; owner: string; description: string; columns: { name: string; type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB'; notNull?: boolean }[]; primaryKey: string[] }
type Cell = string | number | null | { $b64: string };
export interface UserWorkExport {
	format: typeof USER_WORK_EXPORT;
	exportedAt: string;
	tables: (UserWorkTable & { rows: Record<string, Cell>[] })[];
	/** tables of the selected kinds left out because importAll() could not recreate them, each with the reason */
	excluded?: { name: string; kind: TableKind; rows: number; reason: string }[];
}
const q = (id: string) => `"${id.replaceAll('"', '""')}"`;
const MAX_NOTE = 20_000;
const MAX_FIELDS_JSON = 64 * 1024;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type NoteDb = { id: string; case_id: string; anchor_sha256: string | null; ref_at_creation: string; results_version: string; body: string; body_sha256: string; created_at: string };

export class UserWorkError extends Error {}

export class UserWork {
	private readonly storage: Storage;
	private readonly store: CaseStore;
	private readonly onWrite: () => void;
	constructor(storage: Storage, store: CaseStore, onWrite: () => void = () => {}) {
		this.storage = storage;
		this.store = store;
		this.onWrite = onWrite;
	}
	private get d() { return this.storage.db(); }

	/** The anchor for a document of a version: the fingerprint of its verified original, or none. */
	anchorFor(caseId: string, resultsVersion: string, ref: string): DocumentAnchor & { sha256: string | null } {
		const a = this.store.assetForServe(resultsVersion, ref);
		const sha256 = a && (a.status === 'verified' || a.status === 'case-mismatch') ? a.sha256 : null;
		return { caseId, sha256: sha256 as string, refAtCreation: ref, resultsVersion };
	}

	/** Where an anchor points in `resultsVersion`. */
	resolve(anchor: { sha256: string | null; refAtCreation: string; resultsVersion: string; caseId: string }, resultsVersion: string, fingerprints = this.store.fingerprints(resultsVersion)): { status: AnchorStatus; refs: string[] } {
		if (anchor.resultsVersion === resultsVersion) return { status: 'here', refs: [anchor.refAtCreation] };
		if (!anchor.sha256) return { status: 'unanchored', refs: [] };
		const m = matchAnchor(anchor as DocumentAnchor, fingerprints);
		return m.status === 'exact' ? { status: 'exact', refs: [m.ref] } : m.status === 'ambiguous' ? { status: 'ambiguous', refs: m.refs } : { status: 'missing', refs: [] };
	}

	private view(n: NoteDb, status: AnchorStatus, candidates: string[]): NoteView {
		return { id: n.id, body: n.body, createdAt: n.created_at, refAtCreation: n.ref_at_creation, resultsVersion: n.results_version, anchorSha256: n.anchor_sha256, status, candidates, intact: sha(n.body) === n.body_sha256 };
	}

	/** Notes shown on one document of a version, with their anchor status. */
	notesFor(caseId: string, resultsVersion: string, ref: string): NoteView[] {
		const own = this.anchorFor(caseId, resultsVersion, ref).sha256;
		const rows = this.d.prepare(`SELECT * FROM work.note WHERE case_id = ? AND ((results_version = ? AND ref_at_creation = ?) OR (anchor_sha256 IS NOT NULL AND anchor_sha256 = ? AND results_version != ?))
			ORDER BY created_at, id`).all(caseId, resultsVersion, ref, own, resultsVersion) as unknown as NoteDb[];
		const fps = this.store.fingerprints(resultsVersion);
		const out: NoteView[] = [];
		for (const n of rows) {
			const r = this.resolve({ caseId, sha256: n.anchor_sha256, refAtCreation: n.ref_at_creation, resultsVersion: n.results_version }, resultsVersion, fps);
			if (r.status === 'here' || ((r.status === 'exact' || r.status === 'ambiguous') && r.refs.includes(ref))) out.push(this.view(n, r.status, r.status === 'ambiguous' ? r.refs : []));
		}
		return out;
	}

	/** Every note of a case classified against one version (overview and import preview). */
	summary(caseId: string, resultsVersion: string): NoteSummary {
		const rows = this.d.prepare('SELECT * FROM work.note WHERE case_id = ? ORDER BY created_at, id').all(caseId) as unknown as NoteDb[];
		const fps = this.store.fingerprints(resultsVersion);
		const s: NoteSummary = { total: rows.length, here: 0, exact: 0, ambiguous: 0, missing: 0, unanchored: 0, byRef: [], detached: [] };
		const byRef = new Map<string, { n: number; status: AnchorStatus }>();
		for (const n of rows) {
			const r = this.resolve({ caseId, sha256: n.anchor_sha256, refAtCreation: n.ref_at_creation, resultsVersion: n.results_version }, resultsVersion, fps);
			s[r.status]++;
			if (r.status === 'missing' || r.status === 'unanchored') { s.detached.push(this.view(n, r.status, [])); continue; }
			for (const ref of r.refs) { const e = byRef.get(ref) ?? { n: 0, status: r.status }; e.n++; if (r.status === 'ambiguous') e.status = 'ambiguous'; byRef.set(ref, e); }
		}
		s.byRef = [...byRef].map(([ref, e]) => ({ ref, ...e })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
		return s;
	}

	async addNote(caseId: string, resultsVersion: string, ref: string, body: string): Promise<NoteView> {
		const text = body.replace(/\r\n?/g, '\n');
		if (!text.trim() || text.length > MAX_NOTE) throw new UserWorkError(`A note needs 1 to ${MAX_NOTE.toLocaleString('en')} characters.`);
		if (!this.store.document(resultsVersion, ref)) throw new UserWorkError('No such document in this results version.');
		const anchor = this.anchorFor(caseId, resultsVersion, ref);
		const at = now().toISOString();
		const row: NoteDb = { id: randomUUID(), case_id: caseId, anchor_sha256: anchor.sha256, ref_at_creation: ref, results_version: resultsVersion, body: text, body_sha256: sha(text), created_at: at };
		await this.storage.tx((d) => d.prepare('INSERT INTO work.note(id, case_id, anchor_sha256, ref_at_creation, results_version, body, body_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
			.run(row.id, row.case_id, row.anchor_sha256, row.ref_at_creation, row.results_version, row.body, row.body_sha256, at, at));
		this.onWrite();
		return this.view(row, 'here', []);
	}

	async deleteNote(caseId: string, id: string): Promise<boolean> {
		const n = await this.storage.tx((d) => Number(d.prepare('DELETE FROM work.note WHERE case_id = ? AND id = ?').run(caseId, id).changes));
		if (n) this.onWrite();
		return n > 0;
	}

	// ---- seeds ----------------------------------------------------------------------------------------------------

	seedRows(resultsVersion: string, datasetKey?: string): SeedRow[] {
		return this.store.seeds(resultsVersion).filter((s) => !datasetKey || s.dataset_key === datasetKey)
			.map((s) => ({ datasetKey: s.dataset_key, seedId: s.seed_id, seedSha256: s.seed_sha256, record: Object.freeze(JSON.parse(s.record_json)) }));
	}
	overlays(caseId: string, datasetKey?: string): SeedOverlay[] {
		const rows = this.d.prepare('SELECT dataset_key, seed_id, base_seed_sha256, fields FROM work.seed_overlay WHERE case_id = ? ORDER BY dataset_key, seed_id').all(caseId) as { dataset_key: string; seed_id: string; base_seed_sha256: string; fields: string }[];
		return rows.filter((r) => !datasetKey || r.dataset_key === datasetKey).map((r) => ({ caseId, datasetKey: r.dataset_key, seedId: r.seed_id, baseSeedSha256: r.base_seed_sha256, fields: JSON.parse(r.fields) }));
	}
	/** The active version's seeds combined with the case's overlays (GRS-10 viewSeeds). */
	seedViews(caseId: string, resultsVersion: string, datasetKey?: string): SeedView[] {
		return viewSeeds(this.seedRows(resultsVersion, datasetKey), this.overlays(caseId, datasetKey));
	}
	/** Save an edit of a seed, made against the seed content `baseSeedSha256`. */
	async putSeedOverlay(o: SeedOverlay): Promise<void> {
		const fields = checkFields(o.fields);
		await this.storage.tx((d) => d.prepare(`INSERT INTO work.seed_overlay(case_id, dataset_key, seed_id, base_seed_sha256, fields, updated_at) VALUES (?,?,?,?,?,?)
			ON CONFLICT(case_id, dataset_key, seed_id) DO UPDATE SET base_seed_sha256 = excluded.base_seed_sha256, fields = excluded.fields, updated_at = excluded.updated_at`)
			.run(o.caseId, o.datasetKey, o.seedId, o.baseSeedSha256, fields, now().toISOString()));
		this.onWrite();
	}

	// ---- registers ------------------------------------------------------------------------------------------------

	listRows(caseId: string, store: string): RegisterRow[] {
		checkStore(store);
		const rows = this.d.prepare('SELECT row_id, store, anchor, fields, fields_sha256, created_at, updated_at FROM work.register_row WHERE case_id = ? AND store = ? ORDER BY created_at, row_id').all(caseId, store) as
			{ row_id: string; store: string; anchor: string | null; fields: string; fields_sha256: string; created_at: string; updated_at: string }[];
		return rows.map((r) => ({ rowId: r.row_id, store: r.store, anchor: r.anchor ? JSON.parse(r.anchor) : null, fields: JSON.parse(r.fields), createdAt: r.created_at, updatedAt: r.updated_at, intact: sha(r.fields) === r.fields_sha256 }));
	}
	/** Insert (rowId null) or replace one row; returns its stable id. */
	async putRow(caseId: string, store: string, rowId: string | null, fields: Record<string, RegisterValue>, anchor: DocumentAnchor | null = null): Promise<string> {
		checkStore(store);
		const json = checkFields(fields);
		const id = rowId ?? randomUUID();
		const at = now().toISOString();
		await this.storage.tx((d) => d.prepare(`INSERT INTO work.register_row(case_id, store, row_id, anchor, fields, fields_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
			ON CONFLICT(case_id, store, row_id) DO UPDATE SET anchor = excluded.anchor, fields = excluded.fields, fields_sha256 = excluded.fields_sha256, updated_at = excluded.updated_at`)
			.run(caseId, store, id, anchor ? JSON.stringify(anchor) : null, json, sha(json), at, at));
		this.onWrite();
		return id;
	}
	// ---- enumeration -----------------------------------------------------------------------------------------------

	/** Every work.sqlite table with its kind, owner and columns (introspected, so nothing is missed). */
	tables(): UserWorkTable[] { return tablesOf(this.d); }

	/** The distinct register stores in use for a case (register_row is one table holding many stores). */
	registerStores(caseId?: string): string[] {
		const rows = (caseId ? this.d.prepare('SELECT DISTINCT store FROM work.register_row WHERE case_id = ? ORDER BY store').all(caseId) : this.d.prepare('SELECT DISTINCT store FROM work.register_row ORDER BY store').all()) as { store: string }[];
		return rows.map((r) => r.store);
	}

	/**
	 * Define a user-work table for a later ticket (idempotent): it lives in work.sqlite, is enumerated, backed up and
	 * restored like the built-in ones. A primary key of stable ids is required; a different existing shape is refused.
	 */
	async defineTable(def: TableDefinition): Promise<void> {
		const bad = definitionProblem(def);
		if (bad) throw new UserWorkError(bad);
		const existing = this.tables().find((t) => t.name === def.name);
		if (existing) {
			const same = existing.columns.length === def.columns.length && def.columns.every((c, i) => existing.columns[i]?.name === c.name && existing.columns[i]?.type === c.type);
			if (!same) throw new UserWorkError(`table ${def.name} already exists with another shape`);
		}
		await this.storage.tx((d) => createTable(d, def, true));
	}

	/** Every row of the selected kinds of tables (default: user work), in primary-key order. */
	exportAll(opts: { kinds?: TableKind[] } = {}): UserWorkExport {
		const kinds = new Set(opts.kinds ?? ['user-work', 'unregistered']);
		const selected = this.tables().filter((t) => kinds.has(t.kind));
		// Only what importAll() can restore is exported; anything else is named in `excluded`, never silently dropped.
		const excluded = selected.flatMap((t) => {
			const def = definitionOf(t);
			// a rowid table may hold NULL in a declared key column; the restored table keys rows by it, so it is not restorable
			const reason = definitionProblem(def) ?? (this.d.prepare(`SELECT 1 FROM work.${q(t.name)} WHERE ${def.primaryKey.map((k) => `${q(k)} IS NULL`).join(' OR ')} LIMIT 1`).get() ? 'a primary-key column holds empty values' : null);
			return reason ? [{ name: t.name, kind: t.kind, rows: (this.d.prepare(`SELECT count(*) AS n FROM work.${q(t.name)}`).get() as { n: number }).n, reason }] : [];
		});
		const tables = selected.filter((t) => !excluded.some((x) => x.name === t.name)).map((t) => {
			const pk = t.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => q(c.name));
			const rows = (this.d.prepare(`SELECT * FROM work.${q(t.name)}${pk.length ? ` ORDER BY ${pk.join(', ')}` : ''}`).all() as Record<string, unknown>[])
				.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toCell(v)])));
			return { ...t, rows };
		});
		return { format: USER_WORK_EXPORT, exportedAt: now().toISOString(), tables, excluded };
	}

	/**
	 * Restore an export in one transaction: each table in it is replaced by its rows. A table the export defines but
	 * this store lacks is created from the export's columns inside that same transaction (catalogued unless it was
	 * unregistered), so a refused or failed restore leaves no table behind. Everything exportAll() writes restores;
	 * a column mismatch with an existing table, or a shape it could not have written, refuses the whole restore.
	 */
	async importAll(snapshot: UserWorkExport): Promise<{ tables: number; rows: number }> {
		if (snapshot?.format !== USER_WORK_EXPORT || !Array.isArray(snapshot.tables)) throw new UserWorkError(`not a ${USER_WORK_EXPORT} export`);
		const here = new Map(this.tables().map((t) => [t.name, t]));
		const create: { def: TableDefinition; catalogue: boolean }[] = [];
		for (const t of snapshot.tables) {
			const def = definitionOf(t);
			const bad = definitionProblem(def);
			if (bad) throw new UserWorkError(`table ${String(t.name).slice(0, 80)}: ${bad}; nothing was restored`);
			const h = here.get(t.name);
			if (h && (h.columns.length !== t.columns.length || t.columns.some((c, i) => h.columns[i]?.name !== c.name))) throw new UserWorkError(`table ${t.name} has other columns here; nothing was restored`);
			if (!h) create.push({ def, catalogue: t.kind !== 'unregistered' });
		}
		let rows = 0;
		await this.storage.tx((d) => {
			for (const c of create) createTable(d, c.def, c.catalogue);
			for (const t of snapshot.tables) {
				d.exec(`DELETE FROM work.${q(t.name)}`);
				const cols = t.columns.map((c) => c.name);
				const ins = d.prepare(`INSERT INTO work.${q(t.name)}(${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
				for (const r of t.rows) { ins.run(...(cols.map((c) => fromCell(r[c] ?? null)) as never[])); rows++; }
			}
		});
		this.onWrite();
		return { tables: snapshot.tables.length, rows };
	}

	async deleteRow(caseId: string, store: string, rowId: string): Promise<boolean> {
		checkStore(store);
		const n = await this.storage.tx((d) => Number(d.prepare('DELETE FROM work.register_row WHERE case_id = ? AND store = ? AND row_id = ?').run(caseId, store, rowId).changes));
		if (n) this.onWrite();
		return n > 0;
	}
}

// ---- enumeration and generic round trip -------------------------------------------------------------------------

/** Generic catalogue and round trip of work.sqlite; mixed into UserWork below. */
function tablesOf(d: ReturnType<Storage['db']>): UserWorkTable[] {
	// SQLite's own tables are sqlite_*; in LIKE '_' is a wildcard, so the prefix is compared literally
	const names = (d.prepare("SELECT name FROM work.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND name != 'userwork_catalog' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
	const cat = new Map((d.prepare('SELECT name, kind, owner, description FROM work.userwork_catalog').all() as { name: string; kind: TableKind; owner: string; description: string }[]).map((r) => [r.name, r]));
	return names.map((name) => {
		const c = cat.get(name);
		const columns = (d.prepare(`PRAGMA work.table_info(${q(name)})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map((x) => ({ name: x.name, type: x.type, notNull: x.notnull === 1, pk: x.pk }));
		return { name, kind: c?.kind ?? 'unregistered', owner: c?.owner ?? 'unknown', description: c?.description ?? 'not in the user-work catalogue', columns };
	});
}
/** The definition importAll() would create a table from (its listed columns, primary key in key order). */
const definitionOf = (t: Pick<UserWorkTable, 'name' | 'owner' | 'description' | 'columns'>): TableDefinition => ({
	name: t.name, owner: t.owner, description: t.description,
	columns: (Array.isArray(t.columns) ? t.columns : []).map((c) => ({ name: c.name, type: String(c.type).toUpperCase() as 'TEXT', notNull: c.notNull })),
	primaryKey: (Array.isArray(t.columns) ? t.columns : []).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
});
/** Why a table of this shape cannot be defined or restored, or null. */
function definitionProblem(def: TableDefinition): string | null {
	if (typeof def.name !== 'string' || !TABLE.test(def.name) || RESERVED(def.name)) return `invalid table name ${String(def.name).slice(0, 80)} (lower-case letters, digits and _, not starting with sqlite)`;
	if (!def.columns.length || def.columns.some((c) => typeof c.name !== 'string' || !TABLE.test(c.name) || !COLUMN_TYPES.has(c.type))) return 'columns need lower-case names and a TEXT, INTEGER, REAL or BLOB type';
	if (!def.primaryKey.length || def.primaryKey.some((k) => !def.columns.some((c) => c.name === k))) return 'a primary key of stable ids is required';
	return null;
}
/** Create a defined table (inside the caller's transaction) and, unless it stays unregistered, catalogue it. */
function createTable(d: ReturnType<Storage['db']>, def: TableDefinition, catalogue: boolean) {
	const cols = def.columns.map((c) => `${q(c.name)} ${c.type}${c.notNull || def.primaryKey.includes(c.name) ? ' NOT NULL' : ''}`).join(', ');
	d.exec(`CREATE TABLE IF NOT EXISTS work.${q(def.name)} (${cols}, PRIMARY KEY(${def.primaryKey.map(q).join(', ')})) WITHOUT ROWID`);
	if (catalogue) d.prepare(`INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES (?, 'user-work', ?, ?)
		ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, description = excluded.description`).run(def.name, def.owner, def.description);
}
const toCell = (v: unknown): Cell => (v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : (v as Cell));
const fromCell = (v: Cell): unknown => (v !== null && typeof v === 'object' ? new Uint8Array(Buffer.from(v.$b64, 'base64')) : v);

function checkStore(store: string) {
	if (!STORE.test(store)) throw new UserWorkError(`invalid register store name: ${store.slice(0, 80)}`);
}
/** Register and overlay fields: a flat object of strings, finite numbers, booleans or null, at most 64 KiB. */
function checkFields(fields: Record<string, unknown>): string {
	if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new UserWorkError('fields must be an object');
	const clean: Record<string, RegisterValue> = Object.create(null);
	for (const [k, v] of Object.entries(fields)) {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)) throw new UserWorkError(`invalid field name: ${k.slice(0, 80)}`);
		if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) throw new UserWorkError(`field ${k} must be text, a number, a boolean or empty`);
		clean[k] = v;
	}
	const json = JSON.stringify(Object.fromEntries(Object.entries(clean).sort(([a], [b]) => (a < b ? -1 : 1))));
	if (json.length > MAX_FIELDS_JSON) throw new UserWorkError('fields are larger than 64 KiB');
	return json;
}
