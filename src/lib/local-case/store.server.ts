// Results store and activation state over node:sqlite (synchronous). The importer, recovery, routes and the
// originals listener use only this interface for results and activation; user work has its own API
// (user-work.server.ts). Ported from the hardened prototype's repo.ts onto GRS-10's identities: versions are keyed
// by resultsVersion, package_file holds exactly candidate.snapshot(), verification uses verifyCandidateBytes and
// the digest over every projected row.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { verifyCandidateBytes, type Acknowledgement } from '../case-package/index.ts';
import { now } from '../components/clock.ts';
import type { Db, Storage } from './db.server.ts';
import { readModelDigest, type AssetRowW, type DocumentRowW, type Expect, type Projection, type SeedRowW } from './project.server.ts';

export interface Version {
	id: string; case_id: string; case_label: string | null; input_revision_id: string; created: string; import_id: number;
	case_folder: string; case_root: string; case_dev: string; case_ino: string; verdict: string; stored_at: string;
	manifest_sha256: string; diagnostics_sha256: string; validator_version: string; warning_fingerprints: string;
	expect: string; read_model_sha256: string; overview: string;
}
export interface ImportRow {
	id: number; at: string; case_folder: string; package_source: string; case_id: string | null; results_version: string | null;
	manifest_sha256: string | null; verdict: string; outcome: string; report: string;
}
export type CaseVersionRow = Pick<Version, 'id' | 'case_id' | 'import_id' | 'created' | 'stored_at' | 'case_label'> & { documents: number };
export type Verification ={ ok: boolean; reason?: string; ms: number; checked?: Record<string, number> };
export interface ActivationEntry {
	id: number; case_id: string; version_id: string; at: string; kind: string; manifest_sha256: string; read_model_sha256: string;
	diagnostics_sha256: string; validator_version: string; acknowledgement: string | null; accepted_warnings: string;
}
export interface AssetServeRow {
	key: string; kind: string; real_path: string | null; sha256: string | null; size: number | null; media_type: string; status: string;
	download_only: number; case_root: string; case_dev: string; case_ino: string;
}

/** Everything one candidate import writes, in ONE transaction. */
export interface VersionWrite {
	attempt: Omit<ImportRow, 'id' | 'outcome'>;
	version: Omit<Version, 'import_id' | 'expect' | 'read_model_sha256' | 'overview'>;
	files: { path: string; sha256: string; size: number; bytes: Uint8Array }[];
	projection: Projection;
}
export type StoreResult =
	| { kind: 'stored' | 'repaired'; importId: number; readModelSha256: string }
	| { kind: 'identical' | 'conflict'; existing: Version }
	| { kind: 'retired'; retiredAt: string };

const VERSION_COLS = 'id, case_id, case_label, input_revision_id, created, import_id, case_folder, case_root, case_dev, case_ino, verdict, stored_at, manifest_sha256, diagnostics_sha256, validator_version, warning_fingerprints, expect, read_model_sha256, overview';
/** Backups are ordered by a sequence number in the name, never by the wall clock: work-<seq 10 digits>-<stamp>-<label>.sqlite */
const BACKUP_RE = /^work-.*\.sqlite$/;
const backupSeq = (n: string) => { const m = /^work-(\d{10})-/.exec(n); return m ? Number(m[1]) : 0; };

function fsyncPath(p: string) {
	const fd = openSync(p, 'r');
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class CaseStore {
	readonly storage: Storage;
	constructor(storage: Storage) { this.storage = storage; }
	private get d() { return this.storage.db(); }

	getVersion(id: string): Version | undefined {
		return this.d.prepare(`SELECT ${VERSION_COLS} FROM version WHERE id = ?`).get(id) as Version | undefined;
	}
	versionsOf(caseId: string): Pick<Version, 'id' | 'import_id' | 'stored_at' | 'verdict'>[] {
		return this.d.prepare('SELECT id, import_id, stored_at, verdict FROM version WHERE case_id = ? ORDER BY import_id DESC').all(caseId) as Pick<Version, 'id' | 'import_id' | 'stored_at' | 'verdict'>[];
	}
	/** Every stored version of every case, newest import first, with the overview fields the case list shows. */
	caseVersions(): CaseVersionRow[] {
		return this.d.prepare(`SELECT id, case_id, case_label, import_id, created, stored_at, json_extract(overview, '$.counts.documents') AS documents
			FROM version ORDER BY import_id DESC`).all() as unknown as CaseVersionRow[];
	}
	listImports(): Omit<ImportRow, 'report'>[] {
		return this.d.prepare('SELECT id, at, case_folder, package_source, case_id, results_version, manifest_sha256, verdict, outcome FROM import_attempt ORDER BY id DESC LIMIT 50').all() as Omit<ImportRow, 'report'>[];
	}
	getImport(id: number): ImportRow | undefined {
		return this.d.prepare('SELECT * FROM import_attempt WHERE id = ?').get(id) as ImportRow | undefined;
	}
	/** A rejected import writes exactly one row, its attempt with the diagnostics; no bytes, version or projection. */
	recordRejected(a: Omit<ImportRow, 'id' | 'outcome'>): Promise<number> {
		return this.storage.tx((d) => Number(d.prepare('INSERT INTO import_attempt(at, case_folder, package_source, case_id, results_version, manifest_sha256, verdict, outcome, report) VALUES (?,?,?,?,?,?,?,?,?)')
			.run(a.at, a.case_folder, a.package_source, a.case_id, a.results_version, a.manifest_sha256, a.verdict, 'rejected', a.report).lastInsertRowid));
	}

	storeVersion(w: VersionWrite): Promise<StoreResult> {
		return this.storage.tx((d) => {
			// Authoritative immutability check, inside the write lock.
			const existing = d.prepare(`SELECT ${VERSION_COLS} FROM version WHERE id = ?`).get(w.version.id) as Version | undefined;
			if (existing) return { kind: existing.manifest_sha256 === w.version.manifest_sha256 ? 'identical' : 'conflict', existing } as StoreResult;
			const retired = d.prepare('SELECT manifest_sha256, retired_at FROM retired_version WHERE id = ?').get(w.version.id) as { manifest_sha256: string; retired_at: string } | undefined;
			if (retired && retired.manifest_sha256 !== w.version.manifest_sha256) return { kind: 'retired', retiredAt: retired.retired_at } as StoreResult;
			return { kind: 'stored', ...insertVersion(d, w, 'stored') } as StoreResult;
		});
	}

	/**
	 * Repair: the stored rows of a version failed verification and the operator re-imported the SAME package
	 * (byte-identical manifest, freshly validated). Replace every row of that version in ONE transaction; the version
	 * id, its activation history and user work stay. Activation pointers are untouched.
	 */
	repairVersion(w: VersionWrite): Promise<StoreResult> {
		return this.storage.tx((d) => {
			const existing = d.prepare(`SELECT ${VERSION_COLS} FROM version WHERE id = ?`).get(w.version.id) as Version | undefined;
			if (existing && existing.manifest_sha256 !== w.version.manifest_sha256) return { kind: 'conflict', existing } as StoreResult;
			if (existing) deleteVersionRows(d, w.version.id);
			return { kind: 'repaired', ...insertVersion(d, w, 'stored') } as StoreResult;
		});
	}

	/**
	 * The case folder at the recorded path was replaced (restored, re-created): a fresh import of the same package has
	 * just verified every original there, so the version is bound to the folder's new identity.
	 */
	rebindCaseRoot(id: string, dev: string, ino: string): Promise<void> {
		return this.storage.tx((d) => { d.prepare('UPDATE version SET case_dev = ?, case_ino = ? WHERE id = ?').run(dev, ino, id); });
	}

	/** The exact stored package bytes (manifest plus listed files), as importCandidate({files}) takes them. */
	packageFiles(id: string): Map<string, Uint8Array> {
		const rows = this.d.prepare('SELECT path, bytes FROM package_file WHERE version_id = ? ORDER BY path').all(id) as { path: string; bytes: Uint8Array }[];
		return new Map(rows.map((r) => [r.path, new Uint8Array(r.bytes)]));
	}

	/** Full re-verification: stored package bytes (GRS-10 verifyCandidateBytes), row counts and the read-model digest. */
	verifyVersion(id: string): Verification {
		const t0 = performance.now();
		const ms = () => Math.round((performance.now() - t0) * 10) / 10;
		const v = this.getVersion(id);
		if (!v) return { ok: false, reason: `results version ${id} is not stored`, ms: ms() };
		let expect: Expect;
		try { expect = JSON.parse(v.expect) as Expect; } catch { return { ok: false, reason: 'stored expectations unreadable', ms: ms() }; }
		const files = this.packageFiles(id);
		const bytes = verifyCandidateBytes(files, { resultsVersion: v.id, manifestSha256: v.manifest_sha256 });
		if (!bytes.ok) return { ok: false, reason: `stored package bytes do not verify: ${bytes.problems.slice(0, 3).join('; ')}`, ms: ms() };
		const rows = this.projectionRows(id);
		const checked = { files: files.size, documents: rows.documents.length, assets: rows.assets.length, seeds: rows.seeds.length };
		if (checked.files !== expect.files || checked.documents !== expect.documents || checked.assets !== expect.assets || checked.seeds !== expect.seeds)
			return { ok: false, reason: `row counts differ from the import: ${JSON.stringify(checked)} vs ${JSON.stringify(expect)}`, ms: ms(), checked };
		const chron = (this.d.prepare('SELECT chronology_json AS c FROM version WHERE id = ?').get(id) as { c: string }).c;
		const digest = readModelDigest({ ...rows, chronologyJson: chron, overview: v.overview, expect: v.expect });
		if (digest !== v.read_model_sha256) return { ok: false, reason: 'stored rows differ from what was imported (read-model digest mismatch)', ms: ms(), checked };
		return { ok: true, ms: ms(), checked };
	}

	projectionRows(id: string): { documents: DocumentRowW[]; assets: AssetRowW[]; seeds: SeedRowW[] } {
		return {
			documents: this.d.prepare('SELECT ref, ord, row_json, state_json, attachments_json FROM document WHERE version_id = ? ORDER BY ref').all(id) as unknown as DocumentRowW[],
			assets: this.d.prepare('SELECT key, kind, indexed_path, parent_ref, member, ordinal, media_type, text_status, real_path, sha256, size, status, download_only FROM asset WHERE version_id = ? ORDER BY key').all(id) as unknown as AssetRowW[],
			seeds: this.d.prepare('SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM seed WHERE version_id = ? ORDER BY ord').all(id) as unknown as SeedRowW[],
		};
	}

	activePointers(): { case_id: string; version_id: string; previous_version_id: string | null; activated_at: string }[] {
		return this.d.prepare('SELECT case_id, version_id, previous_version_id, activated_at FROM work.active ORDER BY activated_at DESC').all() as
			{ case_id: string; version_id: string; previous_version_id: string | null; activated_at: string }[];
	}
	activeVersionId(caseId: string): string | undefined {
		return (this.d.prepare('SELECT version_id FROM work.active WHERE case_id = ?').get(caseId) as { version_id: string } | undefined)?.version_id;
	}
	activationLog(caseId: string): ActivationEntry[] {
		return this.d.prepare('SELECT * FROM work.activation_log WHERE case_id = ? ORDER BY id DESC').all(caseId) as unknown as ActivationEntry[];
	}
	/** Warnings accepted when `versionId` was last activated (its carry-forward set), or null if never activated. */
	acceptedWarningsOf(versionId: string): string[] | null {
		const row = this.d.prepare('SELECT accepted_warnings AS a FROM work.activation_log WHERE version_id = ? ORDER BY id DESC LIMIT 1').get(versionId) as { a: string } | undefined;
		return row ? (JSON.parse(row.a) as string[]) : null;
	}

	/** The operator-accepted register for one case. Never another case's entries. */
	trustedRegister(caseId: string): string[] {
		return (this.d.prepare('SELECT fingerprint FROM work.trusted_warning WHERE case_id = ? ORDER BY fingerprint').all(caseId) as { fingerprint: string }[]).map((r) => r.fingerprint);
	}
	addTrusted(caseId: string, fingerprints: readonly string[]): Promise<number> {
		const at = now().toISOString();
		return this.storage.tx((d) => {
			const ins = d.prepare('INSERT OR IGNORE INTO work.trusted_warning(case_id, fingerprint, accepted_at) VALUES (?,?,?)');
			let n = 0;
			for (const f of fingerprints) n += Number(ins.run(caseId, f, at).changes);
			return n;
		});
	}

	/** Activation: its own transaction, in work.sqlite only. Records the bound acknowledgement and the carry-forward set. */
	writeActivation(v: Version, kind: string, acknowledgement: Acknowledgement | null, accepted: readonly string[]): Promise<boolean> {
		const at = now().toISOString();
		return this.storage.tx((d) => {
			const prev = (d.prepare('SELECT version_id FROM work.active WHERE case_id = ?').get(v.case_id) as { version_id: string } | undefined)?.version_id ?? null;
			// Authoritative idempotency check under the write lock: re-activating the active version logs nothing.
			const last = d.prepare('SELECT version_id FROM work.activation_log WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(v.case_id) as { version_id: string } | undefined;
			if (prev === v.id && last?.version_id === v.id) return false;
			d.prepare(`INSERT INTO work.active(case_id, version_id, previous_version_id, activated_at) VALUES (?,?,?,?)
				ON CONFLICT(case_id) DO UPDATE SET previous_version_id = active.version_id, version_id = excluded.version_id, activated_at = excluded.activated_at`)
				.run(v.case_id, v.id, prev, at);
			d.prepare('INSERT INTO work.activation_log(case_id, version_id, at, kind, manifest_sha256, read_model_sha256, diagnostics_sha256, validator_version, acknowledgement, accepted_warnings) VALUES (?,?,?,?,?,?,?,?,?,?)')
				.run(v.case_id, v.id, at, kind, v.manifest_sha256, v.read_model_sha256, v.diagnostics_sha256, v.validator_version, acknowledgement ? JSON.stringify(acknowledgement) : null, JSON.stringify([...accepted].sort()));
			return true;
		});
	}

	/**
	 * VACUUM INTO a temp name, fsync, rename, fsync the directory; keep the newest `keep` by SEQUENCE (the next number
	 * after the highest one present), never by the wall clock, and never delete the file just written.
	 */
	backupWork(label: string, keep: number): string {
		const dir = this.storage.backupDir;
		mkdirSync(dir, { recursive: true, mode: 0o700 }); // the directory may have been removed while running
		const seq = Math.max(0, ...readdirSync(dir).filter((n) => BACKUP_RE.test(n)).map(backupSeq)) + 1;
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const name = `work-${String(seq).padStart(10, '0')}-${stamp}-${label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}.sqlite`;
		const tmp = path.join(dir, `.tmp-${process.pid}-${name}`);
		const dest = path.join(dir, name);
		this.d.prepare('VACUUM work INTO ?').run(tmp);
		fsyncPath(tmp);
		renameSync(tmp, dest);
		fsyncPath(dir);
		const all = readdirSync(dir).filter((n) => BACKUP_RE.test(n) && n !== name).sort((x, y) => backupSeq(x) - backupSeq(y) || (x < y ? -1 : x > y ? 1 : 0));
		for (const old of all.slice(0, Math.max(0, all.length - (keep - 1)))) rmSync(path.join(dir, old), { force: true });
		return dest;
	}

	/**
	 * Retention: drop never-activated candidates beyond the newest `keep` per case (activated versions stay for
	 * fallback). Newest = highest import id (monotonic), never stored_at (wall clock). `protect` is never dropped.
	 */
	async pruneCandidates(keep: number, protect?: string): Promise<string[]> {
		const rows = this.d.prepare(`SELECT id, case_id FROM version v
			WHERE NOT EXISTS (SELECT 1 FROM work.activation_log l WHERE l.version_id = v.id)
			  AND NOT EXISTS (SELECT 1 FROM work.active a WHERE a.version_id = v.id)
			ORDER BY case_id, import_id DESC`).all() as { id: string; case_id: string }[];
		const seen = new Map<string, number>();
		const drop = rows.filter((r) => { const n = (seen.get(r.case_id) ?? 0) + 1; seen.set(r.case_id, n); return n > keep && r.id !== protect; }).map((r) => r.id);
		for (const id of drop) await this.storage.tx((t) => {
			t.prepare(`INSERT INTO retired_version(id, manifest_sha256, retired_at) SELECT id, manifest_sha256, ? FROM version WHERE id = ?
				ON CONFLICT(id) DO UPDATE SET manifest_sha256 = excluded.manifest_sha256, retired_at = excluded.retired_at`).run(now().toISOString(), id);
			deleteVersionRows(t, id);
		});
		return drop;
	}

	chronologyJson(id: string): string | undefined {
		return (this.d.prepare('SELECT chronology_json AS c FROM version WHERE id = ?').get(id) as { c: string } | undefined)?.c;
	}
	document(id: string, ref: string): DocumentRowW | undefined {
		return this.d.prepare('SELECT ref, ord, row_json, state_json, attachments_json FROM document WHERE version_id = ? AND ref = ?').get(id, ref) as DocumentRowW | undefined;
	}
	documentCount(id: string): number {
		return (this.d.prepare('SELECT count(*) AS n FROM document WHERE version_id = ?').get(id) as { n: number }).n;
	}
	/** Which of `refs` are imported documents of the version; views resolve refs with resolveRefs() (documents.server.ts), which adds provider rows. */
	existingRefs(id: string, refs: readonly string[]): Set<string> {
		const rows = this.d.prepare('SELECT ref FROM document WHERE version_id = ? AND ref IN (SELECT value FROM json_each(?))').all(id, JSON.stringify(refs)) as { ref: string }[];
		return new Set(rows.map((r) => r.ref));
	}
	/** Chronology rows whose parent is `ref` (extracted attachments with rows of their own). */
	childDocuments(id: string, ref: string): { ref: string; row_json: string }[] {
		return this.d.prepare(`SELECT d.ref, d.row_json FROM document d JOIN asset a ON a.version_id = d.version_id AND a.key = d.ref
			WHERE d.version_id = ? AND a.parent_ref = ? ORDER BY d.ord`).all(id, ref) as { ref: string; row_json: string }[];
	}
	assetForServe(id: string, key: string): AssetServeRow | undefined {
		return this.d.prepare(`SELECT a.key, a.kind, a.real_path, a.sha256, a.size, a.media_type, a.status, a.download_only, v.case_root, v.case_dev, v.case_ino
			FROM asset a JOIN version v ON v.id = a.version_id WHERE a.version_id = ? AND a.key = ?`).get(id, key) as AssetServeRow | undefined;
	}
	/** The package files of a version (P- keys, GRS-45) with what serving them needs, by indexed path. */
	packageFileAssets(id: string): (AssetServeRow & { indexed_path: string })[] {
		return this.d.prepare(`SELECT a.key, a.kind, a.indexed_path, a.real_path, a.sha256, a.size, a.media_type, a.status, a.download_only, v.case_root, v.case_dev, v.case_ino
			FROM asset a JOIN version v ON v.id = a.version_id WHERE a.version_id = ? AND length(a.key) = 18 AND a.key GLOB 'P-[0-9a-f]*' AND a.indexed_path IS NOT NULL ORDER BY a.key`).all(id) as unknown as (AssetServeRow & { indexed_path: string })[];
	}
	/** Every verified document original of a version as {ref, sha256}: the candidates for fingerprint re-anchoring (package files are not documents). */
	fingerprints(id: string): { ref: string; sha256: string }[] {
		return this.d.prepare("SELECT key AS ref, sha256 FROM asset WHERE version_id = ? AND sha256 IS NOT NULL AND status IN ('verified', 'case-mismatch') AND NOT (length(key) = 18 AND key GLOB 'P-[0-9a-f]*') ORDER BY key").all(id) as { ref: string; sha256: string }[];
	}
	seeds(id: string): SeedRowW[] {
		return this.d.prepare('SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM seed WHERE version_id = ? ORDER BY ord').all(id) as unknown as SeedRowW[];
	}
}

/** Insert one validated version (import row, version row, package bytes, read model); returns the import id. */
function insertVersion(d: Db, w: VersionWrite, outcome: string): { importId: number; readModelSha256: string } {
	const a = w.attempt;
	const importId = Number(d.prepare('INSERT INTO import_attempt(at, case_folder, package_source, case_id, results_version, manifest_sha256, verdict, outcome, report) VALUES (?,?,?,?,?,?,?,?,?)')
		.run(a.at, a.case_folder, a.package_source, a.case_id, a.results_version, a.manifest_sha256, a.verdict, outcome, a.report).lastInsertRowid);
	const v = w.version;
	const p = w.projection;
	const expect = JSON.stringify(p.expect);
	const digest = readModelDigest({ documents: p.documents, assets: p.assets, seeds: p.seeds, chronologyJson: p.chronologyJson, overview: p.overview, expect });
	d.prepare(`INSERT INTO version(${VERSION_COLS}, chronology_json) VALUES (${Array(20).fill('?').join(',')})`)
		.run(v.id, v.case_id, v.case_label, v.input_revision_id, v.created, importId, v.case_folder, v.case_root, v.case_dev, v.case_ino, v.verdict, v.stored_at,
			v.manifest_sha256, v.diagnostics_sha256, v.validator_version, v.warning_fingerprints, expect, digest, p.overview, p.chronologyJson);
	const pf = d.prepare('INSERT INTO package_file(version_id, path, sha256, size, bytes) VALUES (?,?,?,?,?)');
	for (const f of w.files) pf.run(v.id, f.path, f.sha256, f.size, f.bytes);
	const doc = d.prepare('INSERT INTO document(version_id, ref, ord, row_json, state_json, attachments_json) VALUES (?,?,?,?,?,?)');
	for (const r of p.documents) doc.run(v.id, r.ref, r.ord, r.row_json, r.state_json, r.attachments_json);
	const as = d.prepare('INSERT INTO asset(version_id, key, kind, indexed_path, parent_ref, member, ordinal, media_type, text_status, real_path, sha256, size, status, download_only) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
	for (const r of p.assets) as.run(v.id, r.key, r.kind, r.indexed_path, r.parent_ref, r.member, r.ordinal, r.media_type, r.text_status, r.real_path, r.sha256, r.size, r.status, r.download_only);
	const sd = d.prepare('INSERT INTO seed(version_id, ord, dataset_key, seed_id, seed_sha256, record_json) VALUES (?,?,?,?,?,?)');
	for (const r of p.seeds) sd.run(v.id, r.ord, r.dataset_key, r.seed_id, r.seed_sha256, r.record_json);
	return { importId, readModelSha256: digest };
}

function deleteVersionRows(d: Db, id: string) {
	for (const tbl of ['document', 'asset', 'seed', 'package_file']) d.prepare(`DELETE FROM ${tbl} WHERE version_id = ?`).run(id);
	d.prepare('DELETE FROM version WHERE id = ?').run(id);
}
