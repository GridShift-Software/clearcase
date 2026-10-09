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
import { createHash, randomUUID } from 'node:crypto';
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
		const at = new Date().toISOString();
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
			.run(o.caseId, o.datasetKey, o.seedId, o.baseSeedSha256, fields, new Date().toISOString()));
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
		const at = new Date().toISOString();
		await this.storage.tx((d) => d.prepare(`INSERT INTO work.register_row(case_id, store, row_id, anchor, fields, fields_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
			ON CONFLICT(case_id, store, row_id) DO UPDATE SET anchor = excluded.anchor, fields = excluded.fields, fields_sha256 = excluded.fields_sha256, updated_at = excluded.updated_at`)
			.run(caseId, store, id, anchor ? JSON.stringify(anchor) : null, json, sha(json), at, at));
		this.onWrite();
		return id;
	}
	async deleteRow(caseId: string, store: string, rowId: string): Promise<boolean> {
		checkStore(store);
		const n = await this.storage.tx((d) => Number(d.prepare('DELETE FROM work.register_row WHERE case_id = ? AND store = ? AND row_id = ?').run(caseId, store, rowId).changes));
		if (n) this.onWrite();
		return n > 0;
	}
}

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
