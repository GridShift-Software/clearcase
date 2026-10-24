-- GRS-115: the per-client D1 layout for hosted results and protected originals. One database per client deployment.
-- Every table is in the `rs_` namespace. The deployment applies this file with `wrangler d1 migrations apply` (the
-- coordinator owns that step and the wrangler configuration); the Worker never creates or alters a table.
-- The layout follows docs/acceptance/hosting/storage.md (GRS-109 probe). Deviations are listed in
-- docs/hosted-foundation/storage.md.

-- The client this database belongs to, provisioned out of band. The Worker refuses every read and write while it is
-- missing or names another client than its deployment's trusted configuration.
CREATE TABLE rs_storage_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL,
  layout TEXT NOT NULL
);

-- A guarded batch inserts NULL here as its first statement when its precondition fails; the NOT NULL failure rolls the
-- whole batch back (a D1 batch is one transaction). Nothing is ever stored here.
CREATE TABLE rs_batch_guard (token TEXT NOT NULL);

-- The cases this deployment serves. Written by provisioning (GRS-114), read here. Grants live with identity.
CREATE TABLE rs_case (
  case_id TEXT PRIMARY KEY,
  case_label TEXT
);

-- An immutable results version. `staging` while an import writes its rows, `stored` once every count and object
-- matched. A stored version never changes; it is reachable by clients only through a publication.
CREATE TABLE rs_results_version (
  version_id TEXT PRIMARY KEY CHECK (version_id GLOB 'sha256:*' AND length(version_id) = 71),
  case_id TEXT NOT NULL REFERENCES rs_case,
  state TEXT NOT NULL CHECK (state IN ('staging', 'stored')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  operation_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  input_revision_id TEXT NOT NULL,
  case_label TEXT,
  created TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'report')),
  validator_version TEXT NOT NULL,
  diagnostics_sha256 TEXT NOT NULL,
  warning_fingerprints TEXT NOT NULL,
  expected_documents INTEGER NOT NULL,
  expected_assets INTEGER NOT NULL,
  expected_seeds INTEGER NOT NULL,
  expected_files INTEGER NOT NULL,
  read_model_sha256 TEXT NOT NULL,
  overview TEXT NOT NULL,
  -- Bytes of the package files: reserved against the cumulative package quotas before the first object is written.
  package_bytes INTEGER NOT NULL CHECK (package_bytes >= 0),
  -- Keep protects a version from pruning only. It never makes a withdrawn version readable.
  keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1)),
  staged_at TEXT NOT NULL,
  stored_at TEXT,
  import_seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX rs_results_version_import_seq ON rs_results_version (import_seq);
CREATE INDEX rs_results_version_case ON rs_results_version (case_id);

-- Exact package files: bytes in R2 under an opaque key, recorded size and SHA-256 checked on every load.
CREATE TABLE rs_package_file (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  object_key TEXT NOT NULL,
  PRIMARY KEY (version_id, path)
);
-- The read model (the canonical projection of the validated package, local-case/project.server.ts's shape).
CREATE TABLE rs_document (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  ref TEXT NOT NULL,
  ord INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  list_json TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  PRIMARY KEY (version_id, ref)
);
CREATE UNIQUE INDEX rs_document_ord ON rs_document (version_id, ord);
CREATE TABLE rs_asset (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  asset_key TEXT NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (version_id, asset_key)
);
CREATE TABLE rs_seed (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  ord INTEGER NOT NULL,
  dataset_key TEXT NOT NULL,
  seed_id TEXT NOT NULL,
  seed_sha256 TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (version_id, ord)
);
-- Version-scoped derivatives (previews). A candidate's previews are never reachable through a published version.
CREATE TABLE rs_preview (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  asset_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  media_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (version_id, asset_id)
);

-- Publication: written only by the publication owner (GRS-31) in one guarded batch; read here. A case without a row
-- has no publication. `withdrawn` keeps the last version for the record and serves none of its derivatives.
CREATE TABLE rs_publication (
  case_id TEXT PRIMARY KEY REFERENCES rs_case,
  state TEXT NOT NULL CHECK (state IN ('published', 'withdrawn')),
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  previous_version_id TEXT REFERENCES rs_results_version
);
-- A withdrawn version: every derivative of it is refused, whatever the publication pointer or its Keep mark says.
CREATE TABLE rs_version_withdrawal (
  version_id TEXT PRIMARY KEY REFERENCES rs_results_version,
  case_id TEXT NOT NULL REFERENCES rs_case,
  withdrawn_at TEXT NOT NULL
);
-- Warning fingerprints the case's publication owner accepted (trusted baseline), read by `trustedFor`.
CREATE TABLE rs_trusted_fingerprint (
  case_id TEXT NOT NULL REFERENCES rs_case,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (case_id, fingerprint)
);

-- Originals: a case-level input, content-addressed in R2 (`orig/<sha256>`, write-once), recorded only after the
-- finalize step hashed the stored object whole. Available through the case grant, with or without a publication.
CREATE TABLE rs_original (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  object_key TEXT NOT NULL UNIQUE
);
CREATE TABLE rs_case_original (
  case_id TEXT NOT NULL REFERENCES rs_case,
  asset_id TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES rs_original,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (case_id, asset_id)
);
-- Upload provenance and staging. `declared` before any byte is written (the row reserves the case's and the client's
-- upload and byte quotas); `stored` once this operation's own `put` carried bytes that hash to the declaration and the
-- object under `orig/<sha256>` matched; `finalized` only in the batch that binds the original. Finalize needs `stored`,
-- so a case never binds an object it did not itself upload. `put_attempts` bounds the writes a retry can send to R2.
-- A `declared` or `stored` row is the durable trace of an object that never finalized (reaper input).
CREATE TABLE rs_original_upload (
  case_id TEXT NOT NULL REFERENCES rs_case,
  operation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('declared', 'stored', 'finalized')),
  put_attempts INTEGER NOT NULL DEFAULT 0 CHECK (put_attempts >= 0),
  declared_at TEXT NOT NULL,
  stored_at TEXT,
  PRIMARY KEY (case_id, operation_id)
);
