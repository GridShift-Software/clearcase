-- The per-client D1 layout the storage probe proves (GRS-109), one database per client. The runner applies it with
-- `wrangler d1 execute --local`, a separate process from the Worker, as the deployment tooling would; the Worker never
-- creates or alters a table. R2 keys are listed in docs/acceptance/hosting/storage.md.

-- The client this database belongs to. Provisioned once, out of band; the Worker refuses every request while it is
-- missing or names another client than its deployment.
CREATE TABLE storage_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), client_id TEXT NOT NULL, layout TEXT NOT NULL);

-- A batch whose precondition fails inserts NULL here as its first statement; the NOT NULL failure rolls the whole batch
-- back (D1 runs a batch as one transaction). The last statement of every guarded batch deletes its own row.
CREATE TABLE batch_guard (token TEXT NOT NULL);

-- Results: immutable once `stored`. A version is identified by its resultsVersion (`sha256:<hex>`).
CREATE TABLE results_version (
  version_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging', 'stored')),
  attempt INTEGER NOT NULL,
  expected_documents INTEGER NOT NULL,
  expected_assets INTEGER NOT NULL,
  expected_seeds INTEGER NOT NULL,
  expected_files INTEGER NOT NULL,
  list_sha256 TEXT NOT NULL,
  list_size INTEGER NOT NULL
);
CREATE TABLE package_file (version_id TEXT NOT NULL REFERENCES results_version, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (version_id, path));
CREATE TABLE document (version_id TEXT NOT NULL REFERENCES results_version, ref TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (version_id, ref));
CREATE TABLE asset (version_id TEXT NOT NULL REFERENCES results_version, asset_id TEXT NOT NULL, sha256 TEXT, size INTEGER, kind TEXT NOT NULL CHECK (kind IN ('file', 'embedded')), PRIMARY KEY (version_id, asset_id));
CREATE TABLE seed (version_id TEXT NOT NULL REFERENCES results_version, seed_id TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (version_id, seed_id));

-- Originals: content-addressed in R2 as orig/<sha256>, recorded only after the finalize step verified the stored bytes.
CREATE TABLE original (sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64), size INTEGER NOT NULL CHECK (size >= 0));
CREATE TABLE case_original (case_id TEXT NOT NULL, asset_id TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES original, filename TEXT NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY (case_id, asset_id));

-- Publication: the version a case's clients see. Candidates stay reachable only by their own resultsVersion internally.
CREATE TABLE active (case_id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES results_version);
CREATE TABLE activation_log (case_id TEXT NOT NULL, seq INTEGER NOT NULL, version_id TEXT NOT NULL, previous TEXT, PRIMARY KEY (case_id, seq));

-- User work. Every table named uw_* is case-scoped (a case_id column) and is what a snapshot and a restore cover: both
-- read the list from sqlite_master, never from a hand-written list. case_rev moves with every user-work write.
CREATE TABLE case_rev (case_id TEXT PRIMARY KEY, rev INTEGER NOT NULL);
CREATE TABLE uw_register_row (case_id TEXT NOT NULL, store TEXT NOT NULL, row_id TEXT NOT NULL, seq INTEGER NOT NULL, version TEXT NOT NULL, fields TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (case_id, row_id), UNIQUE (case_id, store, seq), UNIQUE (case_id, operation_id));
CREATE TABLE uw_note (case_id TEXT NOT NULL, note_id TEXT NOT NULL, anchor TEXT, body TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (case_id, note_id));

-- Exports: one packet per job, written to R2 as a multipart upload, one part of a fixed size per step. entry_state holds
-- the running SHA-256 and CRC-32 of an entry that spans parts.
CREATE TABLE export_job (export_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, version_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('building', 'complete', 'failed')), object_key TEXT NOT NULL, upload_id TEXT NOT NULL, next_entry INTEGER NOT NULL, next_offset INTEGER NOT NULL, parts TEXT NOT NULL, entry_state TEXT, plan TEXT NOT NULL, size INTEGER, sha256 TEXT, failure TEXT);
CREATE TABLE export_entry (export_id TEXT NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL, crc INTEGER NOT NULL, size INTEGER NOT NULL, offset_bytes INTEGER NOT NULL, PRIMARY KEY (export_id, idx));

-- What a restore step wrote under orig/, pkg/ and rm/ before any row names it (finish writes those rows). A case's removal
-- and the 30-day rotation find the objects of a restore that never finished here; written_at is the step's time.
-- in_progress stays 1 across the R2 write, under a lease: expires_at, in D1's clock, is a little after the writer's own deadline
-- (RESTORE_WRITE_MS), when it aborts its PUT. Removal leaves erased_at unset while an intent's lease runs, and treats an
-- intent whose lease has run out as dead: its write finished or never will.
CREATE TABLE restore_object (case_id TEXT NOT NULL, object_key TEXT NOT NULL, written_at TEXT NOT NULL, in_progress INTEGER NOT NULL DEFAULT 0 CHECK (in_progress IN (0, 1)), expires_at TEXT, PRIMARY KEY (case_id, object_key), CHECK (in_progress = 0 OR expires_at IS NOT NULL));

-- The probe's control: the same register add as read-then-write, two statements, no UNIQUE (P4's sensitivity check).
CREATE TABLE probe_naive_seq (case_id TEXT NOT NULL, store TEXT NOT NULL, seq INTEGER NOT NULL);
-- The probe's layout arm: package files as D1 BLOBs, to measure what that costs against R2. Never read by a route.
CREATE TABLE probe_package_blob (version_id TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (version_id, path));
