// Storage: two SQLite files on one node:sqlite connection, in the data directory.
//   results.sqlite (main)  immutable results versions: the exact validated package bytes (package_file) and
//                          their projection into read-model rows (rebuildable from the bytes)
//   work.sqlite    (work)  precious user work and activation state: the active pointer, the activation log with
//                          bound acknowledgements, the per-case trusted-warning register, notes, seed overlays and
//                          register rows
// Journal modes: results.sqlite uses WAL (large immutable imports; checkpointed with TRUNCATE after each import
// and at close); work.sqlite uses a rollback journal (journal_mode=DELETE) so every acknowledged user-work write
// and activation is in the main file at COMMIT: no -wal sidecar that can be truncated, lost, or replayed onto a
// restored backup. synchronous=FULL on both, set per schema AFTER the ATTACH.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { error } from '@sveltejs/kit';

export type SchemaPragmas = { journal_mode: string; synchronous: number };
export type Pragmas = { main: SchemaPragmas; work: SchemaPragmas; foreign_keys: number; sqlite: string };
export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS main.import_attempt(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, case_folder TEXT NOT NULL, package_source TEXT NOT NULL,
  case_id TEXT, results_version TEXT, manifest_sha256 TEXT, verdict TEXT NOT NULL,
  outcome TEXT NOT NULL,           -- stored | rejected (a rejection stores its diagnostics here and nothing else)
  report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS main.version(
  id TEXT PRIMARY KEY,             -- resultsVersion (sha256:<hex>)
  case_id TEXT NOT NULL, case_label TEXT, input_revision_id TEXT NOT NULL, created TEXT NOT NULL,
  import_id INTEGER NOT NULL REFERENCES import_attempt(id),
  case_folder TEXT NOT NULL,       -- as the operator typed it
  case_root TEXT NOT NULL, case_dev TEXT NOT NULL, case_ino TEXT NOT NULL, -- realpath + identity at import (served from)
  verdict TEXT NOT NULL, stored_at TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL, diagnostics_sha256 TEXT NOT NULL, validator_version TEXT NOT NULL,
  warning_fingerprints TEXT NOT NULL, -- JSON array, uncapped, as imported
  expect TEXT NOT NULL,            -- expected row counts, checked on every verification
  read_model_sha256 TEXT NOT NULL, -- digest over every projected row of this version
  overview TEXT NOT NULL, chronology_json TEXT NOT NULL);
-- Ids of candidates removed by retention, with the manifest they had: a results version id is never reused for
-- different content (the same package may come back).
CREATE TABLE IF NOT EXISTS main.retired_version(id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, retired_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS main.package_file(
  version_id TEXT NOT NULL REFERENCES version(id), path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  bytes BLOB NOT NULL, PRIMARY KEY(version_id, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS main.document(
  version_id TEXT NOT NULL REFERENCES version(id), ref TEXT NOT NULL, ord INTEGER NOT NULL,
  row_json TEXT NOT NULL,          -- the raw chronology row, canonical JSON, values unchanged
  state_json TEXT NOT NULL,        -- documentState() projection
  attachments_json TEXT NOT NULL,  -- attachmentsOf() + resolveAttachment() per key
  PRIMARY KEY(version_id, ref)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS main.asset(
  version_id TEXT NOT NULL REFERENCES version(id), key TEXT NOT NULL, kind TEXT NOT NULL,
  indexed_path TEXT, parent_ref TEXT, member TEXT, ordinal INTEGER, media_type TEXT NOT NULL, text_status TEXT NOT NULL,
  real_path TEXT, sha256 TEXT, size INTEGER,
  status TEXT NOT NULL,            -- verified | case-mismatch | missing | embedded | unavailable
  download_only INTEGER NOT NULL,
  PRIMARY KEY(version_id, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS main.seed(
  version_id TEXT NOT NULL REFERENCES version(id), ord INTEGER NOT NULL, dataset_key TEXT NOT NULL,
  seed_id TEXT NOT NULL, seed_sha256 TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(version_id, ord)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS work.active(
  case_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, previous_version_id TEXT, activated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work.activation_log(
  id INTEGER PRIMARY KEY, case_id TEXT NOT NULL, version_id TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- activate | rollback | recovery
  manifest_sha256 TEXT NOT NULL, read_model_sha256 TEXT NOT NULL, diagnostics_sha256 TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  acknowledgement TEXT,            -- the bound clearcase.acknowledgement/1 (JSON) or NULL when nothing was new
  accepted_warnings TEXT NOT NULL); -- acceptedWarnings(): carried forward as trusted for the next import of the case
-- Operator-accepted warnings, scoped by case: an entry for case A never waives a warning in case B.
CREATE TABLE IF NOT EXISTS work.trusted_warning(
  case_id TEXT NOT NULL, fingerprint TEXT NOT NULL, accepted_at TEXT NOT NULL, PRIMARY KEY(case_id, fingerprint)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS work.note(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL,
  anchor_sha256 TEXT,              -- fingerprint of the document's original; NULL when it had none
  ref_at_creation TEXT NOT NULL, results_version TEXT NOT NULL,
  body TEXT NOT NULL, body_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS work.note_case ON note(case_id, anchor_sha256);
CREATE TABLE IF NOT EXISTS work.seed_overlay(
  case_id TEXT NOT NULL, dataset_key TEXT NOT NULL, seed_id TEXT NOT NULL, base_seed_sha256 TEXT NOT NULL,
  fields TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(case_id, dataset_key, seed_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS work.register_row(
  case_id TEXT NOT NULL, store TEXT NOT NULL, row_id TEXT NOT NULL,
  anchor TEXT,                     -- DocumentAnchor JSON or NULL
  fields TEXT NOT NULL, fields_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(case_id, store, row_id)) WITHOUT ROWID;
-- What each work.sqlite table is, for generic enumeration, backup and restore (user-work.server.ts). Tables that M2
-- tickets define through UserWork.defineTable are added here; a table missing from it is still enumerated, as
-- 'unregistered', so a backup never silently misses one.
CREATE TABLE IF NOT EXISTS work.userwork_catalog(
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, description TEXT NOT NULL) WITHOUT ROWID;
INSERT OR IGNORE INTO work.userwork_catalog VALUES
  ('note', 'user-work', 'GRS-12', 'notes on documents, anchored by original fingerprint'),
  ('seed_overlay', 'user-work', 'GRS-12', 'user edits of imported seed rows, keyed by stable seed id'),
  ('register_row', 'user-work', 'GRS-12', 'rows of user-work registers, keyed by stable row id per store'),
  ('trusted_warning', 'user-work', 'GRS-12', 'warnings the operator accepted for a case'),
  ('active', 'activation', 'GRS-12', 'the active results version per case'),
  ('activation_log', 'activation', 'GRS-12', 'every activation with its bound acknowledgement');
`;

export function readPragmas(d: DatabaseSync): Pragmas {
	const one = (sql: string) => Object.values(d.prepare(sql).get() as Record<string, unknown>)[0];
	return {
		main: { journal_mode: String(one('PRAGMA main.journal_mode')), synchronous: Number(one('PRAGMA main.synchronous')) },
		work: { journal_mode: String(one('PRAGMA work.journal_mode')), synchronous: Number(one('PRAGMA work.synchronous')) },
		foreign_keys: Number(one('PRAGMA foreign_keys')),
		sqlite: String(one('SELECT sqlite_version()')),
	};
}

export class StoreGoneError extends Error {}

/** SQLITE_BUSY / SQLITE_LOCKED: another process holds the write lock (beyond busy_timeout). */
export const isBusy = (e: unknown) => {
	const x = e as { errcode?: number; code?: string; message?: string };
	return x?.errcode === 5 || x?.errcode === 6 || /database is locked|SQLITE_BUSY|database table is locked/i.test(String(x?.message ?? ''));
};
const BUSY = 'The ClearCase store is locked by another process; nothing was written. Try again in a moment.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Storage {
	readonly dataDir: string;
	readonly backupDir: string;
	readonly resultsFile: string;
	readonly workFile: string;
	#db: DatabaseSync | null = null;
	#lock: DatabaseSync | null = null;
	#pragmas: Pragmas | null = null;
	/** inode of each store file as opened; a different (or no) file at the path means it was removed or replaced */
	#opened: { results: number; work: number } | null = null;
	/** work.sqlite did not exist when storage was opened (a fresh, empty file was created) */
	workCreatedAtOpen = false;
	/** committed transactions of this process; with the instance id it tells a restored page whether state changed */
	writes = 0;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.backupDir = path.join(dataDir, 'backups');
		this.resultsFile = path.join(dataDir, 'results.sqlite');
		this.workFile = path.join(dataDir, 'work.sqlite');
	}

	get pragmas() { return this.#pragmas; }
	get isOpen() { return this.#db !== null; }

	/** Open (once). Throws on an unusable store; callers turn that into a storage error page, never a crash. */
	db(): DatabaseSync {
		if (this.#db) return this.#db;
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const workExisted = existsSync(this.workFile);
		const d = new DatabaseSync(this.resultsFile);
		try {
			d.exec('PRAGMA busy_timeout=5000;');
			d.prepare('ATTACH DATABASE ? AS work').run(this.workFile);
			d.exec(`PRAGMA main.journal_mode=WAL; PRAGMA main.synchronous=FULL;
				PRAGMA work.journal_mode=DELETE; PRAGMA work.synchronous=FULL;
				PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;`);
			d.exec(SCHEMA);
			const p = readPragmas(d);
			if (p.main.journal_mode !== 'wal' || p.work.journal_mode !== 'delete' || p.main.synchronous !== 2 || p.work.synchronous !== 2)
				throw new Error(`storage pragmas not applied: ${JSON.stringify(p)}`);
			this.#pragmas = p;
			this.#opened = { results: statSync(this.resultsFile).ino, work: statSync(this.workFile).ino };
			this.workCreatedAtOpen = !workExisted;
		} catch (e) {
			try { d.close(); } catch { /* already broken */ }
			throw e;
		}
		this.#db = d;
		return d;
	}

	/**
	 * The open handles still describe the files at the store paths? (rm -rf of the data directory, or a removed or
	 * replaced work.sqlite, leaves this process writing to unlinked inodes: every later acknowledged write would be
	 * lost.) Two stat() calls; run before every request and every transaction.
	 */
	checkStoreFiles() {
		if (!this.#opened) return;
		for (const [name, file, ino] of [['results.sqlite', this.resultsFile, this.#opened.results], ['work.sqlite', this.workFile, this.#opened.work]] as const) {
			let now: number | null = null;
			try { now = statSync(file).ino; } catch { /* missing */ }
			if (now !== ino)
				throw new StoreGoneError(`${name} was ${now === null ? 'removed' : 'replaced'} while ClearCase was running (data directory ${this.dataDir}). Nothing more is written; restart ClearCase.`);
		}
	}

	/**
	 * Exclusive instance lock on the data directory, taken before startup touches anything. It is a SQLite file held
	 * in EXCLUSIVE locking mode: the kernel releases it when the process dies (no stale lock files), and a second
	 * process on the same directory fails at once instead of pruning, sweeping or writing.
	 */
	acquireInstanceLock(): { ok: true } | { ok: false; reason: string } {
		if (this.#lock) return { ok: true };
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const l = new DatabaseSync(path.join(this.dataDir, 'instance.lock'));
		try {
			l.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE;
				BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER, started_at TEXT);
				DELETE FROM owner; COMMIT;`);
			l.prepare('INSERT INTO owner VALUES (?, ?)').run(process.pid, new Date().toISOString()); // keeps the EXCLUSIVE lock
			this.#lock = l;
			try { writeFileSync(path.join(this.dataDir, 'instance.pid'), `${process.pid}\n`); } catch { /* informational only */ }
			return { ok: true };
		} catch (e) {
			try { l.close(); } catch { /* not ours */ }
			let other = '';
			try { other = ` (pid ${readFileSync(path.join(this.dataDir, 'instance.pid'), 'utf8').trim()})`; } catch { /* unknown */ }
			return { ok: false, reason: `another ClearCase process${other} is using the data directory ${this.dataDir}: ${(e as Error).message}` };
		}
	}

	releaseInstanceLock() {
		// Bun keeps an EXCLUSIVE lock past close() unless the mode is dropped and the file touched first.
		try { this.#lock?.exec('PRAGMA locking_mode=NORMAL; SELECT count(*) FROM owner;'); } catch { /* not held */ }
		try { this.#lock?.close(); } catch { /* exiting */ }
		this.#lock = null;
	}

	/**
	 * One BEGIN IMMEDIATE transaction (write lock taken up front, so no mid-transaction SQLITE_BUSY upgrade). Every
	 * write goes through here. If another process holds the lock beyond busy_timeout, retry with backoff (the event
	 * loop is free between attempts); afterwards answer 503 (with Retry-After), never 500. Nothing is half-written
	 * either way. Also refuses to write into a store whose files were removed or replaced under the running process.
	 */
	async tx<T>(fn: (d: DatabaseSync) => T): Promise<T> {
		const d = this.db();
		try { this.checkStoreFiles(); } catch (e) { error(503, (e as Error).message); }
		for (let attempt = 0; ; attempt++) {
			try {
				d.exec('BEGIN IMMEDIATE');
			} catch (e) {
				if (!isBusy(e)) throw e;
				if (attempt >= 3) error(503, BUSY);
				await sleep(250 * (attempt + 1));
				continue;
			}
			try {
				const out = fn(d);
				d.exec('COMMIT');
				this.writes++;
				return out;
			} catch (e) {
				if (d.isTransaction) d.exec('ROLLBACK');
				if (isBusy(e)) error(503, BUSY);
				throw e;
			}
		}
	}

	/** After an import: move the committed import from results.sqlite-wal into the main file (best effort). */
	checkpointResults() {
		try { this.db().exec('PRAGMA main.wal_checkpoint(TRUNCATE);'); } catch (e) { console.error('results checkpoint skipped:', (e as Error).message); }
	}

	quickCheck(schema: 'main' | 'work'): string {
		return String(Object.values(this.db().prepare(`PRAGMA ${schema}.quick_check(1)`).get() as Record<string, unknown>)[0]);
	}

	/** Changes whenever ANOTHER connection commits to either store file (used to invalidate cached verifications). */
	dataVersion(): string {
		const one = (sql: string) => Object.values(this.db().prepare(sql).get() as Record<string, unknown>)[0];
		return `${one('PRAGMA main.data_version')}/${one('PRAGMA work.data_version')}`;
	}

	close() {
		if (this.#db) {
			try {
				// A clean close checkpoints the results WAL into the main file and removes -wal/-shm.
				this.#db.exec('PRAGMA main.wal_checkpoint(TRUNCATE);');
				this.#db.close();
			} catch (e) { console.error('storage close failed', e); }
			this.#db = null;
			this.#opened = null;
		}
		this.releaseInstanceLock();
	}
}
