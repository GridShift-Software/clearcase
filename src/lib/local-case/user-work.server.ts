import type { TableRestore, TableRestoreReport, ImportResult } from '../server/runtime/dto.ts';
export type { TableRestore, TableRestoreReport, ImportResult } from '../server/runtime/dto.ts';
import type { UserWorkErrorCode } from '../server/runtime/dto.ts';
export type { UserWorkErrorCode } from '../server/runtime/dto.ts';
import type { TableKind, TableScope, TableColumn, UserWorkTable, TableDefinition, TableCell, UserWorkExport } from '../server/runtime/dto.ts';
export type { TableKind, TableScope, TableColumn, UserWorkTable, TableDefinition, TableCell, UserWorkExport } from '../server/runtime/dto.ts';
import type { AnchorStatus, NoteView, NoteSummary, RegisterRow, RegisterValue } from '../server/runtime/dto.ts';
export type { AnchorStatus, NoteView, NoteSummary, RegisterRow, RegisterValue } from '../server/runtime/dto.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isHttpError } from '@sveltejs/kit';
import { now } from '../components/clock.ts';
import { matchAnchor, viewSeeds, type DocumentAnchor, type SeedOverlay, type SeedRow, type SeedView } from '../case-package/index.ts';
import type { Storage } from './db.server.ts';
import type { CaseStore } from './store.server.ts';

type Cell = TableCell;

const STORE = /^[a-z][a-z0-9-]{0,63}$/;
const TABLE = /^[a-z][a-z0-9_]{0,62}$/;
const COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB']);
const CATALOGUE = 'userwork_catalog';
const RESERVED = (name: string) => name.startsWith('sqlite') || name.startsWith(CATALOGUE);
const SCOPE_TABLE = 'userwork_catalog_scope';
const BUILT_IN = new Set(['note', 'seed_overlay', 'register_row', 'trusted_warning', 'active', 'activation_log']);
const ACTIVATION = new Set(['active', 'activation_log']);
const TRUST = 'trusted_warning';
const CASE_COLUMN = 'case_id';
const PROBE = 'userwork_catalog_probe';
export const USER_WORK_EXPORT = 'clearcase.user-work/1';

const q = (id: string) => `"${id.replaceAll('"', '""')}"`;
const MAX_NOTE = 20_000;
const MAX_FIELDS_JSON = 64 * 1024;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type NoteDb = { id: string; case_id: string; anchor_sha256: string | null; ref_at_creation: string; results_version: string; body: string; body_sha256: string; created_at: string };

export class UserWorkError extends Error {
	readonly code: UserWorkErrorCode;
	constructor(message: string, code: UserWorkErrorCode = 'invalid') {
		super(message);
		this.code = code;
	}
}
export interface ImportOptions {
	replace?: 'cases' | 'tables'; cases?: string[];
	clearAbsent?: boolean;
}
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

	anchorFor(caseId: string, resultsVersion: string, ref: string): DocumentAnchor & { sha256: string | null } {
		const a = this.store.assetForServe(resultsVersion, ref);
		const sha256 = a && (a.status === 'verified' || a.status === 'case-mismatch') ? a.sha256 : null;
		return { caseId, sha256: sha256 as string, refAtCreation: ref, resultsVersion };
	}

	resolve(anchor: { sha256: string | null; refAtCreation: string; resultsVersion: string; caseId: string }, resultsVersion: string, fingerprints = this.store.fingerprints(resultsVersion)): { status: AnchorStatus; refs: string[] } {
		if (anchor.resultsVersion === resultsVersion) return { status: 'here', refs: [anchor.refAtCreation] };
		if (!anchor.sha256) return { status: 'unanchored', refs: [] };
		const m = matchAnchor(anchor as DocumentAnchor, fingerprints);
		return m.status === 'exact' ? { status: 'exact', refs: [m.ref] } : m.status === 'ambiguous' ? { status: 'ambiguous', refs: m.refs } : { status: 'missing', refs: [] };
	}

	private view(n: NoteDb, status: AnchorStatus, candidates: string[]): NoteView {
		return { id: n.id, body: n.body, createdAt: n.created_at, refAtCreation: n.ref_at_creation, resultsVersion: n.results_version, anchorSha256: n.anchor_sha256, status, candidates, intact: sha(n.body) === n.body_sha256 };
	}

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


	seedRows(resultsVersion: string, datasetKey?: string): SeedRow[] {
		return this.store.seeds(resultsVersion).filter((s) => !datasetKey || s.dataset_key === datasetKey)
			.map((s) => ({ datasetKey: s.dataset_key, seedId: s.seed_id, seedSha256: s.seed_sha256, record: Object.freeze(JSON.parse(s.record_json)) }));
	}
	overlays(caseId: string, datasetKey?: string): SeedOverlay[] {
		const rows = this.d.prepare('SELECT dataset_key, seed_id, base_seed_sha256, fields FROM work.seed_overlay WHERE case_id = ? ORDER BY dataset_key, seed_id').all(caseId) as { dataset_key: string; seed_id: string; base_seed_sha256: string; fields: string }[];
		return rows.filter((r) => !datasetKey || r.dataset_key === datasetKey).map((r) => ({ caseId, datasetKey: r.dataset_key, seedId: r.seed_id, baseSeedSha256: r.base_seed_sha256, fields: JSON.parse(r.fields) }));
	}
	seedViews(caseId: string, resultsVersion: string, datasetKey?: string): SeedView[] {
		return viewSeeds(this.seedRows(resultsVersion, datasetKey), this.overlays(caseId, datasetKey));
	}
	async putSeedOverlay(o: SeedOverlay): Promise<void> {
		const fields = checkFields(o.fields);
		await this.storage.tx((d) => d.prepare(`INSERT INTO work.seed_overlay(case_id, dataset_key, seed_id, base_seed_sha256, fields, updated_at) VALUES (?,?,?,?,?,?)
			ON CONFLICT(case_id, dataset_key, seed_id) DO UPDATE SET base_seed_sha256 = excluded.base_seed_sha256, fields = excluded.fields, updated_at = excluded.updated_at`)
			.run(o.caseId, o.datasetKey, o.seedId, o.baseSeedSha256, fields, now().toISOString()));
		this.onWrite();
	}


	listRows(caseId: string, store: string): RegisterRow[] {
		checkStore(store);
		const rows = this.d.prepare('SELECT row_id, store, anchor, fields, fields_sha256, created_at, updated_at FROM work.register_row WHERE case_id = ? AND store = ? ORDER BY created_at, row_id').all(caseId, store) as
			{ row_id: string; store: string; anchor: string | null; fields: string; fields_sha256: string; created_at: string; updated_at: string }[];
		return rows.map((r) => ({ rowId: r.row_id, store: r.store, anchor: r.anchor ? JSON.parse(r.anchor) : null, fields: JSON.parse(r.fields), createdAt: r.created_at, updatedAt: r.updated_at, intact: sha(r.fields) === r.fields_sha256 }));
	}
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

	tables(): UserWorkTable[] { return tablesOf(this.d); }

	private stateTables(): Set<string> {
		return new Set([...ACTIVATION, ...(this.d.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name.toLowerCase())]);
	}

	registerStores(caseId?: string): string[] {
		const rows = (caseId ? this.d.prepare('SELECT DISTINCT store FROM work.register_row WHERE case_id = ? ORDER BY store').all(caseId) : this.d.prepare('SELECT DISTINCT store FROM work.register_row ORDER BY store').all()) as { store: string }[];
		return rows.map((r) => r.store);
	}

	private async write<T>(what: () => string, fn: (d: ReturnType<Storage['db']>) => T): Promise<T> {
		try {
			return await this.storage.tx(fn);
		} catch (e) {
			if (e instanceof UserWorkError || isHttpError(e)) throw e;
			const kind = (e as { errstr?: unknown } | null)?.errstr;
			throw new UserWorkError(`${what()} failed${typeof kind === 'string' && /^[a-z ]{1,60}$/.test(kind) ? ` (${kind})` : ''}; nothing was written`);
		}
	}

	async defineTable(def: TableDefinition): Promise<void> {
		const bad = definitionProblem(def) ?? (def.scope === 'case' || def.scope === 'store' ? null : "scope is required: 'case' or 'store'");
		if (bad) throw new UserWorkError(bad);
		if (BUILT_IN.has(def.name) || this.stateTables().has(def.name)) throw new UserWorkError(`table ${def.name} is built in and cannot be redefined`, 'table-built-in');
		const existing = this.tables().find((t) => t.name.toLowerCase() === def.name);
		if (existing) {
			const differs = schemaDifference(definitionOf(existing), def) ?? (existing.name !== def.name ? 'a table of that name in another letter case exists' : null);
			if (differs) throw new UserWorkError(`table ${def.name} already exists with another shape: ${differs}`, 'table-conflict');
			if (existing.kind !== 'unregistered' && existing.owner !== def.owner) throw new UserWorkError(`table ${def.name} is owned by ${existing.owner}`, 'table-conflict');
			if (existing.scope !== def.scope) throw new UserWorkError(`table ${def.name} is ${existing.scope}-scoped here; a table's scope cannot change`, 'table-conflict');
		}
		const wrong = scopeProblem(def, def.scope, true);
		if (wrong) throw new UserWorkError(`table ${def.name}: ${wrong}`);
		await this.write(() => `defining table ${def.name}`, (d) => {
			const coll = existing && collationProblem(d, def, existing.kind !== 'user-work');
			if (coll) throw new UserWorkError(`table ${def.name}: ${coll}`, 'table-conflict');
			createTable(d, def, true, def.scope);
		});
	}


	private definedTable(table: unknown, owner?: unknown): UserWorkTable {
		if (typeof table !== 'string') throw new UserWorkError('a table name is text');
		if (BUILT_IN.has(table.toLowerCase()) || this.stateTables().has(table.toLowerCase())) throw new UserWorkError(`table ${table.slice(0, 80)} is built in: use its own API`, 'table-built-in');
		const t = tablesOf(this.d, table);
		if (!t || t.kind !== 'user-work') throw new UserWorkError(`no table ${table.slice(0, 80)} defined through defineTable`);
		if (owner === undefined) return t;
		if (typeof owner !== 'string') throw new UserWorkError('owner is text');
		if (owner !== t.owner) throw new UserWorkError(`table ${t.name} is owned by ${t.owner}`, 'table-conflict');
		return t;
	}

	listTableRows(table: string, opts: { caseId?: string } = {}): Record<string, TableCell>[] {
		const t = this.definedTable(table);
		const caseId = opts?.caseId;
		if (t.scope === 'case' ? typeof caseId !== 'string' : caseId !== undefined) throw new UserWorkError(`table ${t.name} is ${t.scope}-scoped: ${t.scope === 'case' ? 'caseId is required' : 'it has no cases'}`);
		const def = definitionOf(t);
		const select = this.d.prepare(`SELECT * FROM work.${q(t.name)}${t.scope === 'case' ? ` WHERE ${q(CASE_COLUMN)} = ?` : ''} ORDER BY ${def.primaryKey.map(q).join(', ')}`);
		select.setReadBigInts(true);
		const rows = (t.scope === 'case' ? select.all(caseId!) : select.all()) as Record<string, unknown>[];
		return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toCell(v)])));
	}

	async putTableRow(table: string, row: Record<string, TableCell>, opts: { owner: string }): Promise<void> {
		await this.putTableRows(table, [row], opts);
	}

	async putTableRows(table: string, rows: readonly Record<string, TableCell>[], opts: { owner: string }): Promise<void> {
		const t = this.definedTable(table, opts?.owner ?? null);
		const def = definitionOf(t);
		if (!rows.length) return;
		const cols = def.columns.map((c) => c.name);
		const checked = rows.map((row) => {
			if (!isRecord(row)) throw new UserWorkError(`table ${t.name}: a row is an object`);
			const extra = Object.keys(row).find((k) => !def.columns.some((c) => c.name === k));
			if (extra !== undefined) throw new UserWorkError(`table ${t.name}: the row has a column the table lacks${TABLE.test(extra) ? ` (${extra})` : ''}`);
			const r = Object.fromEntries(cols.map((c) => [c, cellOf(row, c)])) as Record<string, Cell>;
			const bad = rowsProblem(this.d, def, t.scope, [r]) ?? numberInText(def, r);
			if (bad) throw new UserWorkError(`table ${t.name}: ${bad.message}; nothing was written`, bad.code);
			return r;
		});
		const rest = cols.filter((c) => !def.primaryKey.includes(c));
		const guard = t.scope === 'case' && !def.primaryKey.includes(CASE_COLUMN);
		const upsert = rest.length ? `UPDATE SET ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}${guard ? ` WHERE ${q(CASE_COLUMN)} = excluded.${q(CASE_COLUMN)}` : ''}` : 'NOTHING';
		await this.write(() => `writing ${rows.length > 1 ? `${rows.length} rows` : 'a row'} of table ${t.name}`, (d) => {
			const st = d.prepare(`INSERT INTO work.${q(t.name)}(${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${def.primaryKey.map(q).join(', ')}) DO ${upsert} RETURNING *`);
			for (const r of checked) {
				const stored = storedRow(st, cols.map((c) => fromCell(r[c])));
				if (guard && !stored) throw new UserWorkError(`table ${t.name}: the row's primary key (${def.primaryKey.join(', ')}) is held by a row of another case here; nothing was written`, 'restore-key-collision');
				const conv = stored && storedProblem(def, stored);
				if (conv) throw new UserWorkError(`table ${t.name}: ${conv.message}; nothing was written`, conv.code);
			}
		});
		this.onWrite();
	}

	async deleteTableRow(table: string, key: Record<string, TableCell>, opts: { owner: string }): Promise<boolean> {
		const t = this.definedTable(table, opts?.owner ?? null);
		const def = definitionOf(t);
		const by = t.scope === 'case' && !def.primaryKey.includes(CASE_COLUMN) ? [...def.primaryKey, CASE_COLUMN] : def.primaryKey;
		if (!isRecord(key)) throw new UserWorkError(`table ${t.name}: a key is an object`);
		const extra = Object.keys(key).find((k) => !by.includes(k));
		if (extra !== undefined) throw new UserWorkError(`table ${t.name}: a key has the columns (${by.join(', ')})`);
		const k = Object.fromEntries(by.map((c) => [c, cellOf(key, c)])) as Record<string, Cell>;
		if (t.scope === 'case' && typeof k[CASE_COLUMN] !== 'string') throw new UserWorkError(`table ${t.name}: a key of a case-scoped table names its ${CASE_COLUMN} as text`);
		const bad = Object.values(k).every(isCell) ? numberInText(def, k) ?? keyProblem(def, k) : { code: 'invalid' as const, message: 'a key cell is not a string, finite number, null, {$b64} or 64-bit {$int}' };
		if (bad) throw new UserWorkError(`table ${t.name}: ${bad.message}`, bad.code);
		const n = await this.write(() => `deleting a row of table ${t.name}`, (d) => Number(d.prepare(`DELETE FROM work.${q(t.name)} WHERE ${by.map((c) => `${q(c)} = ?`).join(' AND ')}`).run(...(by.map((c) => fromCell(k[c])) as never[])).changes));
		if (n) this.onWrite();
		return n > 0;
	}

	exportAll(opts: { kinds?: TableKind[] } = {}): UserWorkExport {
		const kinds = new Set(opts.kinds ?? ['user-work', 'unregistered']);
		const here = this.target();
		const freshStore: Target = { ...here, here: new Map([...here.here].filter(([n]) => BUILT_IN.has(n))), others: new Set() };
		const tables: UserWorkExport['tables'] = [];
		const excluded: NonNullable<UserWorkExport['excluded']> = [];
		for (const t of this.tables().filter((x) => kinds.has(x.kind))) {
			const def = definitionOf(t);
			// INTEGERs are read as BigInt: one beyond 2^53 would otherwise throw RangeError and fail the whole export
			const select = here.state.has(t.name.toLowerCase()) || t.kind === 'activation' || definitionProblem(def) ? null : this.d.prepare(`SELECT * FROM work.${q(t.name)} ORDER BY ${def.primaryKey.map(q).join(', ')}`);
			select?.setReadBigInts(true);
			const rows = select ? (select.all() as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toCell(v)]))) : [];
			const entry = { ...t, rows };
			const same = restorePlan(this.d, here, entry);
			const fresh = 'code' in same ? same : restorePlan(this.d, freshStore, entry);
			if ('code' in fresh) {
				const n = select ? rows.length : (this.d.prepare(`SELECT count(*) AS n FROM work.${q(t.name)}`).get() as { n: number }).n;
				excluded.push({ name: t.name, kind: t.kind, rows: n, reason: fresh === same ? fresh.message : `in a fresh store: ${fresh.message}` });
				continue;
			}
			tables.push(entry);
		}
		return { format: USER_WORK_EXPORT, exportedAt: now().toISOString(), tables, excluded };
	}

	private target(): Target {
		return {
			here: new Map(this.tables().map((t) => [t.name.toLowerCase(), t])),
			state: this.stateTables(),
			others: new Set((this.d.prepare("SELECT name FROM work.sqlite_master WHERE type != 'table'").all() as { name: string }[]).map((r) => r.name.toLowerCase())),
		};
	}

	async importAll(snapshot: UserWorkExport, opts: ImportOptions = {}): Promise<ImportResult> {
		if (!isRecord(snapshot) || snapshot.format !== USER_WORK_EXPORT || !Array.isArray(snapshot.tables)) throw new UserWorkError(`not a ${USER_WORK_EXPORT} export`);
		const replace = opts?.replace ?? 'cases';
		if (replace !== 'cases' && replace !== 'tables') throw new UserWorkError("replace is 'cases' or 'tables'");
		if (opts?.clearAbsent !== undefined && typeof opts.clearAbsent !== 'boolean') throw new UserWorkError('clearAbsent is true or false');
		if (opts?.cases !== undefined && !(Array.isArray(opts.cases) && opts.cases.every((c) => typeof c === 'string'))) throw new UserWorkError('cases is a list of case ids');
		const plans: Plan[] = [];
		let cases: string[] = [];
		const restored: TableRestoreReport[] = [];
		const dropped: NonNullable<ImportResult['dropped']> = [];
		let rows = 0;
		let current = '';
		await this.write(() => `restoring table ${current}`, (d) => {
			const at = this.target();
			for (const [i, t] of (snapshot.tables as unknown[]).entries()) {
				if (!isRecord(t)) throw new UserWorkError(`table entry ${i} is not a table; nothing was restored`);
				const name = typeof t.name === 'string' ? t.name.slice(0, 80) : `#${i}`;
				current = name;
				const p = plans.some((x) => x.def.name === t.name) ? { code: 'invalid' as const, message: 'the snapshot lists the table twice' } : restorePlan(d, at, t);
				if ('code' in p) throw new UserWorkError(`table ${name}: ${p.message}; nothing was restored`, p.code);
				plans.push(p);
			}
			cases = opts?.cases ? [...new Set(opts.cases)].sort() : [...new Set(plans.filter((p) => p.scope === 'case' && p.def.name !== TRUST).flatMap((p) => p.rows.map((r) => cellOf(r, CASE_COLUMN) as string)))].sort();
			const json = JSON.stringify(cases);
			if (replace === 'cases') for (const p of plans) {
				if (p.scope !== 'case' || p.create || p.def.name === TRUST || p.def.primaryKey.includes(CASE_COLUMN)) continue;
				const st = d.prepare(`SELECT 1 FROM work.${q(p.def.name)} WHERE ${p.def.primaryKey.map((k) => `${q(k)} = ?`).join(' AND ')} AND ${q(CASE_COLUMN)} NOT IN (SELECT value FROM json_each(?)) LIMIT 1`);
				for (const r of p.rows) {
					if (st.get(...(p.def.primaryKey.map((k) => fromCell(cellOf(r, k))) as never[]), json)) throw new UserWorkError(`table ${p.def.name}: a row's primary key (${p.def.primaryKey.join(', ')}) is held by a row of another case here; nothing was restored`, 'restore-key-collision');
				}
			}
			for (const p of plans) if (p.create) createTable(d, p.def, p.catalogue, p.scope);
			for (const p of plans) {
				const { def, scope } = p;
				current = def.name;
				if (def.name === TRUST) {
					if (p.rows.length) dropped.push({ name: TRUST, rows: p.rows.length, reason: 'a restore never creates trust: accepted warnings are acknowledged again' });
					restored.push({ name: def.name, scope, action: 'dropped', rows: 0, deleted: 0 });
					continue;
				}
				const action: TableRestore = replace === 'tables' ? 'replaced' : scope === 'store' ? 'merged' : cases.length ? 'replaced-for-cases' : 'no-cases';
				if (action === 'no-cases') { restored.push({ name: def.name, scope, action, rows: 0, deleted: 0 }); continue; }
				const count = () => Number((d.prepare(`SELECT count(*) AS n FROM work.${q(def.name)}`).get() as { n: number }).n);
				const before = action === 'merged' ? count() : 0;
				const touched = action !== 'replaced-for-cases' ? [] : (d.prepare(`SELECT DISTINCT ${q(CASE_COLUMN)} AS c FROM work.${q(def.name)} WHERE ${q(CASE_COLUMN)} IN (SELECT value FROM json_each(?))`).all(json) as { c: string }[]).map((x) => x.c);
				const deleted = action === 'replaced' ? Number(d.prepare(`DELETE FROM work.${q(def.name)}`).run().changes)
					: action === 'replaced-for-cases' ? Number(d.prepare(`DELETE FROM work.${q(def.name)} WHERE ${q(CASE_COLUMN)} IN (SELECT value FROM json_each(?))`).run(json).changes) : 0;
				const cols = def.columns.map((c) => c.name);
				const rest = cols.filter((c) => !def.primaryKey.includes(c));
				const merge = action !== 'merged' ? '' : ` ON CONFLICT(${def.primaryKey.map(q).join(', ')}) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}` : 'NOTHING'}`;
				const ins = d.prepare(`INSERT INTO work.${q(def.name)}(${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${merge} RETURNING *`);
				for (const r of p.rows) {
					const stored = storedRow(ins, cols.map((c) => fromCell(cellOf(r, c))));
					const conv = stored && storedProblem(def, stored);
					if (conv) throw new UserWorkError(`table ${def.name}: ${conv.message}; nothing was restored`, conv.code);
				}
				rows += p.rows.length;
				const report: TableRestoreReport = { name: def.name, scope, action, rows: p.rows.length, deleted };
				if (action === 'merged') { const inserted = count() - before; Object.assign(report, { inserted, replaced: p.rows.length - inserted }); }
				if (action === 'replaced-for-cases') report.cases = [...new Set([...touched, ...p.rows.map((x) => cellOf(x, CASE_COLUMN) as string)])].sort();
				restored.push(report);
			}
			if (opts?.clearAbsent && replace === 'cases' && cases.length) {
				const listed = new Set(plans.map((p) => p.def.name.toLowerCase()));
				const named = (list: unknown) => (Array.isArray(list) ? list : []).flatMap((x) => (isRecord(x) && typeof x.name === 'string' ? [x.name.toLowerCase()] : []));
				const kept = new Set([...named(snapshot.excluded), ...named(this.exportAll().excluded)]);
				for (const t of this.tables()) {
					const lower = t.name.toLowerCase();
					if (t.scope !== 'case' || t.kind === 'activation' || t.name === TRUST || at.state.has(lower) || listed.has(lower)) continue;
					current = t.name;
					if (kept.has(lower)) { restored.push({ name: t.name, scope: 'case', action: 'kept-excluded', rows: 0, deleted: 0 }); continue; }
					const deleted = Number(d.prepare(`DELETE FROM work.${q(t.name)} WHERE ${q(CASE_COLUMN)} IN (SELECT value FROM json_each(?))`).run(json).changes);
					restored.push({ name: t.name, scope: 'case', action: 'cleared-for-cases', rows: 0, deleted });
				}
			}
		});
		this.onWrite();
		const result: ImportResult = { tables: plans.length, rows, cases, restored };
		return dropped.length ? { ...result, dropped } : result;
	}

	async deleteRow(caseId: string, store: string, rowId: string): Promise<boolean> {
		checkStore(store);
		const n = await this.storage.tx((d) => Number(d.prepare('DELETE FROM work.register_row WHERE case_id = ? AND store = ? AND row_id = ?').run(caseId, store, rowId).changes));
		if (n) this.onWrite();
		return n > 0;
	}
}


const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function scopesOf(d: ReturnType<Storage['db']>): Map<string, TableScope> {
	if (!d.prepare("SELECT 1 FROM work.sqlite_master WHERE type = 'table' AND name = ?").get(SCOPE_TABLE)) return new Map();
	return new Map((d.prepare(`SELECT name, scope FROM work.${SCOPE_TABLE}`).all() as { name: string; scope: TableScope }[]).map((r) => [r.name, r.scope]));
}
function tablesOf(d: ReturnType<Storage['db']>): UserWorkTable[];
function tablesOf(d: ReturnType<Storage['db']>, only: string): UserWorkTable | null;
function tablesOf(d: ReturnType<Storage['db']>, only?: string): UserWorkTable[] | UserWorkTable | null {
	// SQLite's own tables are sqlite_*; in LIKE '_' is a wildcard, so the prefixes are compared literally
	const names = (d.prepare(`SELECT name FROM work.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, ${CATALOGUE.length}) != '${CATALOGUE}' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
		.filter((n) => only === undefined || n === only);
	const cat = new Map((d.prepare('SELECT name, kind, owner, description FROM work.userwork_catalog').all() as { name: string; kind: TableKind; owner: string; description: string }[]).map((r) => [r.name, r]));
	const scopes = scopesOf(d);
	const all = names.map((name): UserWorkTable => {
		const c = cat.get(name);
		const columns = (d.prepare(`PRAGMA work.table_info(${q(name)})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map((x) => ({ name: x.name, type: x.type, notNull: x.notnull === 1, pk: x.pk }));
		const scope: TableScope = BUILT_IN.has(name) ? 'case' : c ? scopes.get(name) ?? 'store' : 'store';
		return { name, kind: c?.kind ?? 'unregistered', scope, owner: c?.owner ?? 'unknown', description: c?.description ?? 'not in the user-work catalogue', columns };
	});
	return only === undefined ? all : all[0] ?? null;
}
type Shape = Omit<TableDefinition, 'scope'>;
const definitionOf = (t: Pick<UserWorkTable, 'name' | 'owner' | 'description' | 'columns'>): Shape => {
	const columns = (Array.isArray(t.columns) ? t.columns : []).map((c) => (isRecord(c) ? c : {}) as Partial<TableColumn>);
	return {
		name: t.name, owner: t.owner, description: t.description,
		columns: columns.map((c) => ({ name: c.name as string, type: String(c.type).toUpperCase() as 'TEXT', notNull: c.notNull === true })),
		primaryKey: columns.filter((c) => typeof c.pk === 'number' && c.pk > 0).sort((a, b) => a.pk! - b.pk!).map((c) => c.name as string),
	};
};
function schemaDifference(here: Shape, backup: Shape): string | null {
	const cols = (d: Shape) => d.columns.map((c) => c.name).join(', ');
	if (here.columns.length !== backup.columns.length || here.columns.some((c, i) => c.name !== backup.columns[i]!.name)) return `its columns here are (${cols(here)}), the backup's are (${cols(backup)})`;
	const notNull = (d: Shape, c: Shape['columns'][number]) => !!c.notNull || d.primaryKey.includes(c.name);
	for (const [i, c] of here.columns.entries()) {
		const b = backup.columns[i]!;
		if (c.type !== b.type) return `column ${c.name} is ${c.type || 'untyped'} here and ${b.type} in the backup`;
		if (notNull(here, c) !== notNull(backup, b)) return `column ${c.name} is ${notNull(here, c) ? 'NOT NULL' : 'nullable'} here and ${notNull(backup, b) ? 'NOT NULL' : 'nullable'} in the backup`;
	}
	if (here.primaryKey.join(', ') !== backup.primaryKey.join(', ')) return `its primary key here is (${here.primaryKey.join(', ')}), the backup's is (${backup.primaryKey.join(', ')})`;
	return null;
}
function definitionProblem(def: Shape): string | null {
	if (!isRecord(def)) return 'a table definition is an object';
	if (typeof def.name !== 'string' || !TABLE.test(def.name) || RESERVED(def.name)) return `invalid table name ${String(def.name).slice(0, 80)} (lower-case letters, digits and _, not starting with sqlite or ${CATALOGUE})`;
	if (typeof def.owner !== 'string' || typeof def.description !== 'string') return 'owner and description must be text';
	if (!Array.isArray(def.columns) || !def.columns.length || def.columns.some((c) => !isRecord(c) || typeof c.name !== 'string' || !TABLE.test(c.name) || !COLUMN_TYPES.has(c.type))) return 'columns need lower-case names and a TEXT, INTEGER, REAL or BLOB type';
	if (new Set(def.columns.map((c) => c.name)).size !== def.columns.length) return 'a column is listed twice';
	if (!Array.isArray(def.primaryKey) || !def.primaryKey.length || def.primaryKey.some((k) => !def.columns.some((c) => c.name === k))) return 'a primary key of stable ids is required';
	if (new Set(def.primaryKey).size !== def.primaryKey.length) return 'a primary-key column is listed twice';
	return null;
}
function scopeProblem(def: Shape, scope: unknown, defining: boolean): string | null {
	if (scope !== 'case' && scope !== 'store') return "scope is 'case' or 'store'";
	const c = def.columns.find((x) => x.name === CASE_COLUMN);
	if (scope === 'case' && !(c && c.type === 'TEXT' && (c.notNull || def.primaryKey.includes(CASE_COLUMN)))) return `a case-scoped table needs a ${CASE_COLUMN} TEXT NOT NULL column`;
	if (scope === 'store' && c && defining) return `a store-scoped table has no ${CASE_COLUMN} column (declare scope 'case' for per-case rows)`;
	return null;
}
const cellOf = (r: Record<string, unknown>, column: string): unknown => (Object.hasOwn(r, column) ? r[column] ?? null : null);
const INT64 = [-(2n ** 63n), 2n ** 63n - 1n] as const;
const isInt64 = (s: unknown) => typeof s === 'string' && /^-?\d{1,19}$/.test(s) && BigInt(s) >= INT64[0] && BigInt(s) <= INT64[1];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function isCell(v: unknown): boolean {
	if (v === null || typeof v === 'string') return true;
	if (typeof v === 'number') return Number.isFinite(v);
	if (!isRecord(v)) return false;
	const keys = Object.keys(v);
	if (keys.length !== 1) return false;
	return keys[0] === '$b64' ? typeof v.$b64 === 'string' && BASE64.test(v.$b64) : keys[0] === '$int' && isInt64(v.$int);
}
type Problem = { code: UserWorkErrorCode; message: string };
function keyProblem(def: Shape, r: Record<string, unknown>): Problem | null {
	for (const k of def.primaryKey) {
		const v = cellOf(r, k) as Cell;
		const integer = typeof v === 'number' ? Number.isSafeInteger(v) : isRecord(v) && '$int' in v;
		if (v === null || (def.columns.find((c) => c.name === k)!.type === 'INTEGER' && !integer)) return { code: 'restore-key', message: `a primary-key cell (${k}) is empty or not an integer` };
	}
	return null;
}
/** A table-row write refuses a number in a TEXT column: SQLite stores it as REAL text (7 as '7.0', and a large
 *  integer rounded), a key that text '7' never matches. A restore accepts it (exportAll never writes one). */
function numberInText(def: Shape, r: Record<string, unknown>): Problem | null {
	const c = def.columns.find((x) => x.type === 'TEXT' && typeof cellOf(r, x.name) === 'number');
	return c ? { code: 'invalid', message: `column ${c.name} is TEXT and a cell is a number; pass text` } : null;
}
/** Text SQLite reads as a number in a REAL column (its affinity converts it): a decimal or exponent literal. */
const NUMERIC_TEXT = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;
/** A key cell (checked by isCell) as SQLite holds it in a column of `type`, so two cells SQLite stores as one key
 *  collide: TEXT turns a number into SQLite's own text for it and `{$int}` into its decimal, REAL turns every number,
 *  `{$int}` and numeric text into a number, and a BLOB is compared by its bytes. */
function keyIdentity(d: ReturnType<Storage['db']>, type: string, v: Cell): string {
	if (v === null) return 'null';
	if (typeof v === 'object' && '$b64' in v) return `b${Buffer.from(v.$b64, 'base64').toString('base64')}`;
	const n = typeof v === 'object' ? BigInt(v.$int) : v;
	if (type === 'TEXT') return `s${typeof n === 'number' ? (d.prepare('SELECT CAST(? AS TEXT) AS t').get(n) as { t: string }).t : String(n)}`;
	if (typeof n === 'string') return type === 'REAL' && NUMERIC_TEXT.test(n) ? `n${Number(n)}` : `s${n}`;
	return `n${type === 'REAL' ? Number(n) : n}`;
}
function rowsProblem(d: ReturnType<Storage['db']>, def: Shape, scope: TableScope, rows: Record<string, unknown>[]): Problem | null {
	const keys = new Set<string>();
	const types = def.primaryKey.map((k) => def.columns.find((c) => c.name === k)!.type);
	for (const r of rows) {
		for (const c of def.columns) {
			const v = cellOf(r, c.name);
			if (!isCell(v)) return { code: def.primaryKey.includes(c.name) && isRecord(v) && '$int' in v ? 'restore-key' : 'invalid', message: `a cell of column ${c.name} is not a string, finite number, null, {$b64} or 64-bit {$int}` };
		}
		const keyBad = keyProblem(def, r);
		if (keyBad) return keyBad;
		const id = JSON.stringify(def.primaryKey.map((k, i) => keyIdentity(d, types[i]!, cellOf(r, k) as Cell)));
		if (keys.has(id)) return { code: 'restore-key', message: `a primary key (${def.primaryKey.join(', ')}) appears twice` };
		keys.add(id);
		const missing = def.columns.find((c) => c.notNull && cellOf(r, c.name) === null);
		if (missing) return { code: 'invalid', message: `column ${missing.name} is NOT NULL and a row leaves it empty` };
		if (scope === 'case' && typeof cellOf(r, CASE_COLUMN) !== 'string') return { code: 'invalid', message: `a ${CASE_COLUMN} cell of a case-scoped table is not text` };
	}
	return null;
}
function storedRow(st: ReturnType<ReturnType<Storage['db']>['prepare']>, values: unknown[]): Record<string, unknown> | null {
	st.setReadBigInts(true);
	const r = st.get(...(values as never[])) as Record<string, unknown> | undefined;
	return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toCell(v)])) : null;
}
/** Why a stored row is not a row exportAll() can write: column affinity turned numeric text into a non-finite number
 *  ('1e999' in a REAL, INTEGER or NUMERIC column). A write or restore that stores one is rolled back. */
function storedProblem(def: Shape, stored: Record<string, unknown>): Problem | null {
	const c = def.columns.find((x) => !isCell(cellOf(stored, x.name)));
	return c ? { code: 'invalid', message: `column ${c.name}: SQLite stores a cell as a number out of range (numeric text beyond the REAL range)` } : null;
}

type Plan = { def: Shape; scope: TableScope; rows: Record<string, Cell>[]; create: boolean; catalogue: boolean };
type Target = { here: Map<string, UserWorkTable>; state: Set<string>; others: Set<string> };
function restorePlan(d: ReturnType<Storage['db']>, at: Target, t: Record<string, unknown>): Plan | Problem {
	const invalid = (message: string): Problem => ({ code: 'invalid', message });
	const raw = typeof t.name === 'string' ? t.name.toLowerCase() : null;
	if ((raw !== null && (at.state.has(raw) || at.here.get(raw)?.kind === 'activation')) || t.kind === 'activation') return { code: 'restore-state', message: 'a restore never writes activation or import state' };
	const def = definitionOf(t as unknown as UserWorkTable);
	const bad = definitionProblem(def) ?? (Array.isArray(t.rows) && t.rows.every(isRecord) ? null : 'rows must be a list of objects')
		?? (at.others.has(def.name) ? 'an index, view or trigger here has that name' : null);
	if (bad) return invalid(bad);
	const h = at.here.get(def.name);
	const differs = h && (schemaDifference(definitionOf(h), def) ?? (h.name !== def.name ? 'a table of that name in another letter case exists here' : null));
	if (differs) return invalid(`${differs} (restore into a store whose table matches the backup, or migrate the table first)`);
	const catalogued = !h && t.kind !== 'unregistered';
	const caseShaped = catalogued && !scopeProblem(def, 'case', false);
	const scope = (t.scope === undefined ? h?.scope ?? (caseShaped ? 'case' : 'store') : t.scope) as TableScope;
	const kind = h?.kind ?? t.kind;
	const wrong = scopeProblem(def, scope, false) ?? (h && h.scope !== scope ? `it is ${h.scope}-scoped here and ${scope}-scoped in the backup` : null)
		?? (kind === 'unregistered' && scope !== 'store' ? 'an unregistered table is store-scoped' : null)
		?? (caseShaped && scope === 'store' ? `a table with a ${CASE_COLUMN} TEXT NOT NULL column is case-scoped (declare scope 'case', as defineTable does)` : null);
	if (wrong) return invalid(wrong);
	const rows = t.rows as Record<string, Cell>[];
	const rowBad = def.name === TRUST ? null : rowsProblem(d, def, scope, rows);
	if (rowBad) return rowBad;
	const coll = h && !BUILT_IN.has(def.name) ? collationProblem(d, def, true) : null;
	if (coll) return { code: 'table-conflict', message: coll };
	return { def, scope, rows, create: !h, catalogue: t.kind !== 'unregistered' };
}
function createTable(d: ReturnType<Storage['db']>, def: Shape, catalogue: boolean, scope: TableScope) {
	const cols = def.columns.map((c) => `${q(c.name)} ${c.type}${c.notNull || def.primaryKey.includes(c.name) ? ' NOT NULL' : ''}`).join(', ');
	d.exec(`CREATE TABLE IF NOT EXISTS work.${q(def.name)} (${cols}, PRIMARY KEY(${def.primaryKey.map(q).join(', ')})) WITHOUT ROWID`);
	if (!catalogue) return;
	d.prepare(`INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES (?, 'user-work', ?, ?)
		ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, description = excluded.description`).run(def.name, def.owner, def.description);
	d.exec(`CREATE TABLE IF NOT EXISTS work.${SCOPE_TABLE}(name TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('case', 'store'))) WITHOUT ROWID`);
	d.prepare(`INSERT INTO work.${SCOPE_TABLE}(name, scope) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET scope = excluded.scope`).run(def.name, scope);
}
/**
 * Why an existing table's key or case_id columns would not compare byte for byte, or null. SQLite reports no column
 * collation directly: with `probe`, an index on the columns (created in a savepoint that is always rolled back)
 * inherits each column's own; the primary-key index carries the key columns' own and any its PRIMARY KEY clause adds.
 */
function collationProblem(d: ReturnType<Storage['db']>, def: Shape, probe: boolean): string | null {
	const cols = [...new Set([...def.primaryKey, ...def.columns.filter((c) => c.name === CASE_COLUMN).map((c) => c.name)])];
	type Xinfo = { name: string | null; coll: string; key: number };
	let own: Xinfo[] = [];
	if (probe) {
		d.exec(`SAVEPOINT ${PROBE}`);
		try {
			d.exec(`CREATE INDEX work.${q(PROBE)} ON ${q(def.name)}(${cols.map(q).join(', ')})`);
			own = d.prepare(`PRAGMA work.index_xinfo(${q(PROBE)})`).all() as Xinfo[];
		} finally {
			d.exec(`ROLLBACK TO ${PROBE}; RELEASE ${PROBE}`);
		}
	}
	const pk = (d.prepare(`PRAGMA work.index_list(${q(def.name)})`).all() as { name: string; origin: string }[]).filter((i) => i.origin === 'pk')
		.flatMap((i) => d.prepare(`PRAGMA work.index_xinfo(${q(i.name)})`).all() as Xinfo[]);
	const bad = [...own, ...pk].find((x) => x.key && x.name !== null && cols.includes(x.name) && x.coll.toUpperCase() !== 'BINARY');
	return bad ? `column ${bad.name} has the collation ${bad.coll}; a key or ${CASE_COLUMN} column must compare byte for byte (BINARY)` : null;
}
const toCell = (v: unknown): Cell =>
	v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : { $int: v.toString() }) : (v as Cell);
const fromCell = (v: unknown): unknown => {
	if (v === null || typeof v !== 'object') return v;
	if ('$int' in v) return BigInt((v as { $int: string }).$int);
	return new Uint8Array(Buffer.from((v as { $b64: string }).$b64, 'base64'));
};

function checkStore(store: string) {
	if (!STORE.test(store)) throw new UserWorkError(`invalid register store name: ${store.slice(0, 80)}`);
}
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
