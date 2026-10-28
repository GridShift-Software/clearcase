-- ClearCase native alpha schema; source c6f0d9536e381dc8eebbf2035f49834409434761
-- DDL only. Trusted binding identities, cases, grants and runtime sentinel data are separate.
CREATE TABLE IF NOT EXISTS runtime_sentinel (name TEXT PRIMARY KEY, value TEXT NOT NULL);

-- src/lib/audit/migrations/0001_native_audit.sql
-- GRS-116 native request audit log, applied to each client's own D1 database. No table here is shared between clients.
-- Owned names: native_audit_*. No foreign key to any rs_*, tenant_* or case table. Unreleased: this file may still be
-- corrected in place until a first apply is recorded.
--
-- Threat boundary. The constraints and triggers below stop ordinary SQL from rewriting history by accident or through
-- an unreviewed statement: UPDATE, DELETE, INSERT OR REPLACE (with or without recursive_triggers), rebinding the client
-- and resetting a counter. They are plain SQLite triggers, not PRAGMA settings. They are NOT protection against a SQL
-- administrator who can DROP a trigger or table, or replace the database; nothing here is tamper-proof.

-- The one client this database belongs to. Written only by trusted provisioning (provisionAuditBinding), never from a
-- request. A database without this row refuses every audit append, find and query. The counters are the capacity
-- ledger: one per event class (see the events table), so reads can never use up the budget of protected business events.
CREATE TABLE native_audit_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 63),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  denial_count INTEGER NOT NULL DEFAULT 0 CHECK (denial_count >= 0),
  denial_unlogged INTEGER NOT NULL DEFAULT 0 CHECK (denial_unlogged >= 0),
  bound_at TEXT NOT NULL
);
-- One row, once, with zeroed counters. Fires before any conflict handling, so INSERT OR REPLACE cannot swap the row.
CREATE TRIGGER native_audit_binding_once BEFORE INSERT ON native_audit_binding
WHEN EXISTS (SELECT 1 FROM native_audit_binding) OR NEW.event_count <> 0 OR NEW.read_count <> 0 OR NEW.denial_count <> 0 OR NEW.denial_unlogged <> 0
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: bound once, counters start at zero'); END;
CREATE TRIGGER native_audit_binding_no_rebind BEFORE UPDATE ON native_audit_binding
WHEN NEW.singleton <> OLD.singleton OR NEW.client_id <> OLD.client_id OR NEW.bound_at <> OLD.bound_at
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: client_id is fixed'); END;
-- A counter never decreases, and one statement raises the counters by at most one in total (the insert trigger below,
-- or the denial_unlogged note), so an arbitrary UPDATE cannot reset or jump a quota.
CREATE TRIGGER native_audit_binding_counters BEFORE UPDATE ON native_audit_binding
WHEN NEW.event_count < OLD.event_count OR NEW.read_count < OLD.read_count OR NEW.denial_count < OLD.denial_count OR NEW.denial_unlogged < OLD.denial_unlogged
  OR (NEW.event_count + NEW.read_count + NEW.denial_count + NEW.denial_unlogged) - (OLD.event_count + OLD.read_count + OLD.denial_count + OLD.denial_unlogged) > 1
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: counters only grow, by one'); END;
CREATE TRIGGER native_audit_binding_no_delete BEFORE DELETE ON native_audit_binding
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: binding is permanent'); END;

-- Append-only events. canonical holds the exact canonical JSON of the event envelope; sha256 is its digest. The other
-- columns are indexes over the same values, never a second source of truth.
-- class separates capacity: 'protected' events are the business events producers append; 'read' is a served audit.read;
-- 'denial' is an audit.read that was refused or failed. Only 'protected' rows are charged to maxRows.
CREATE TABLE native_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  envelope INTEGER NOT NULL CHECK (envelope = 1),
  class TEXT NOT NULL DEFAULT 'protected' CHECK (class IN ('protected', 'read', 'denial')),
  actor_key TEXT,
  action TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  case_id TEXT,
  version TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed', 'refused')),
  -- 'system' is automated provisioning (the grant-admin bootstrap): not an identity, written only by the trusted
  -- provisioning port, and refused by every request port in code.
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('anonymous', 'verified', 'system')),
  at TEXT NOT NULL,
  canonical TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  CHECK (
    (class = 'protected' AND action <> 'audit.read')
    OR (class = 'read' AND action = 'audit.read' AND outcome = 'succeeded')
    OR (class = 'denial' AND action = 'audit.read' AND outcome IN ('denied', 'failed'))
  )
);
CREATE INDEX native_audit_events_case ON native_audit_events (client_id, case_id, seq);
CREATE INDEX native_audit_events_admin ON native_audit_events (client_id, seq) WHERE case_id IS NULL;
CREATE INDEX native_audit_events_denials ON native_audit_events (class, actor_key);

-- Every event belongs to the bound client; an unbound database accepts none.
CREATE TRIGGER native_audit_events_bound BEFORE INSERT ON native_audit_events
WHEN NOT EXISTS (SELECT 1 FROM native_audit_binding WHERE singleton = 1 AND client_id = NEW.client_id)
BEGIN SELECT RAISE(ABORT, 'native_audit_events: client not bound'); END;
-- An event id and a sequence number are used once. This fires before conflict handling, so INSERT OR REPLACE cannot swap
-- a stored row (REPLACE deletes without firing delete triggers unless recursive_triggers is on, so the guard is here).
CREATE TRIGGER native_audit_events_no_reuse BEFORE INSERT ON native_audit_events
WHEN EXISTS (SELECT 1 FROM native_audit_events WHERE event_id = NEW.event_id OR seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only, ids and sequence are never reused'); END;
-- Protected history: no update, no delete.
CREATE TRIGGER native_audit_events_no_update BEFORE UPDATE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
CREATE TRIGGER native_audit_events_no_delete BEFORE DELETE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
-- The capacity counter of the event's class, kept in the same statement as the insert.
CREATE TRIGGER native_audit_events_count AFTER INSERT ON native_audit_events
BEGIN
  UPDATE native_audit_binding SET
    event_count = event_count + (NEW.class = 'protected'),
    read_count = read_count + (NEW.class = 'read'),
    denial_count = denial_count + (NEW.class = 'denial')
  WHERE singleton = 1;
END;


-- src/lib/storage/cloud/migrations/0001_rs_results_storage.sql
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


-- src/lib/tenancy/migrations/0001_tenant_case_grants.sql
-- GRS-114: explicit case and grant-management grants of one client instance. Owned by src/lib/tenancy only.
-- Case existence is asked through an injected CaseDirectory port (GRS-115 storage), so there is no foreign key to a
-- case table here. client_id is kept on every row and every query, so a row of another client never answers.
CREATE TABLE IF NOT EXISTS tenant_case_grants (
  grant_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('case', 'client')),
  case_id TEXT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) > 0),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('client', 'staff')),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'operator', 'publisher', 'grant-admin')),
  slot TEXT NOT NULL CHECK (slot IN ('content', 'operator', 'publisher', 'grant-admin')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  expires_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  created_by_issuer TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes TEXT,
  revoked_operation_id TEXT,
  revoked_at TEXT,
  CHECK ((scope = 'case') = (case_id IS NOT NULL)),
  CHECK ((scope = 'client') = (role = 'grant-admin')),
  CHECK (slot = CASE WHEN role IN ('viewer', 'editor') THEN 'content' ELSE role END),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
-- One live (pending or active) grant per principal, scope and slot; a pending create holds its slot.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_live ON tenant_case_grants (client_id, scope, ifnull(case_id, ''), issuer, subject, slot) WHERE state <> 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_created_op ON tenant_case_grants (client_id, created_operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_revoked_op ON tenant_case_grants (client_id, revoked_operation_id) WHERE revoked_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_case_grants_principal ON tenant_case_grants (client_id, issuer, subject, scope, case_id);


-- src/lib/tenancy/migrations/0002_tenant_grant_operations.sql
-- GRS-114 fix round 1: the operation ledger of grant management. Additive only: tenant_case_grants, its grant ids and its
-- constraints are not touched. One row per management operation, written in the same D1 batch (one transaction) as the
-- grant change it records, so an operation id is bound to the actor, kind and request that first used it, and the exact
-- audit event it must persist (payload and digest) is fixed before the first append is tried. A retry reads this row and
-- never rebuilds the event, its actor, its session or its instant.
CREATE TABLE IF NOT EXISTS tenant_grant_operations (
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'revoke', 'bootstrap')),
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('client', 'staff', 'control-plane')),
  request TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES tenant_case_grants (grant_id),
  event_json TEXT NOT NULL,
  event_digest TEXT NOT NULL CHECK (length(event_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('recorded', 'audited')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (client_id, operation_id)
);
CREATE INDEX IF NOT EXISTS tenant_grant_operations_grant ON tenant_grant_operations (client_id, grant_id);


-- src/lib/tenancy/migrations/0003_tenant_upload_grants.sql
-- NATIVE24: the explicit, distinct case.upload-originals grant of one client instance. Additive only: the 0001 and 0002
-- tables, their roles, grant ids and constraints are not read, altered or referenced. Applied by trusted provisioning,
-- after 0001 and 0002, to the client's own D1 database.
--
-- The grant is NOT a case role of the 0001 table. A viewer, editor, operator, publisher or grant-admin row confers no
-- upload; only a row here, for the exact (client, case, issuer, subject, principal kind) tuple, does.
--
-- The platform enforces what the application also checks:
--   * the database is pinned to one client by an immutable tenant_upload_binding row that only trusted provisioning
--     writes. Every grant row must name that client, so an unbound database or a row of another client is refused;
--   * a grant is inserted pending and becomes active only after its issue operation is `audited`, i.e. after its audit
--     event is confirmed persisted. A row cannot be inserted active, a revoked row never revives, and the tuple of a
--     grant and its ledger row can never be changed or deleted.
-- Trigger messages do not contain the word "constraint": an adapter treats that word as a lost race, and these are faults.
CREATE TABLE IF NOT EXISTS tenant_upload_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0),
  d1_database_id TEXT NOT NULL CHECK (length(d1_database_id) > 0)
);
CREATE TRIGGER IF NOT EXISTS tenant_upload_binding_fixed_update BEFORE UPDATE ON tenant_upload_binding
BEGIN SELECT RAISE(ABORT, 'the upload binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_binding_fixed_delete BEFORE DELETE ON tenant_upload_binding
BEGIN SELECT RAISE(ABORT, 'the upload binding is immutable'); END;

CREATE TABLE IF NOT EXISTS tenant_upload_grants (
  grant_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL CHECK (length(case_id) > 0),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) > 0),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('client', 'staff')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  expires_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_operation_id TEXT,
  revoked_at TEXT,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_operation_id IS NOT NULL))
);
-- One live (pending or active) grant per exact tuple; a pending issue holds its slot.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_upload_grants_live ON tenant_upload_grants (client_id, case_id, issuer, subject, principal_kind) WHERE state <> 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_upload_grants_created_op ON tenant_upload_grants (client_id, created_operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_upload_grants_revoked_op ON tenant_upload_grants (client_id, revoked_operation_id) WHERE revoked_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_upload_grants_principal ON tenant_upload_grants (client_id, case_id, issuer, subject, principal_kind);

CREATE TABLE IF NOT EXISTS tenant_upload_grant_operations (
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('issue', 'revoke')),
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'control-plane'),
  request TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES tenant_upload_grants (grant_id),
  event_json TEXT NOT NULL,
  event_digest TEXT NOT NULL CHECK (length(event_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('recorded', 'audited')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (client_id, operation_id)
);
CREATE INDEX IF NOT EXISTS tenant_upload_grant_operations_grant ON tenant_upload_grant_operations (client_id, grant_id);

CREATE TRIGGER IF NOT EXISTS tenant_upload_grants_insert_pending BEFORE INSERT ON tenant_upload_grants
WHEN NEW.state <> 'pending' OR NEW.version <> 1 OR NOT EXISTS (SELECT 1 FROM tenant_upload_binding WHERE client_id = NEW.client_id)
BEGIN SELECT RAISE(ABORT, 'an upload grant is inserted pending, into a database bound to its client'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grants_tuple_fixed BEFORE UPDATE OF grant_id, client_id, case_id, issuer, subject, principal_kind, created_operation_id, request, created_at ON tenant_upload_grants
BEGIN SELECT RAISE(ABORT, 'an upload grant tuple is fixed'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grants_revoked_final BEFORE UPDATE ON tenant_upload_grants
WHEN OLD.state = 'revoked'
BEGIN SELECT RAISE(ABORT, 'a revoked upload grant never revives'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grants_active_after_ack BEFORE UPDATE OF state ON tenant_upload_grants
WHEN NEW.state = 'active' AND NOT (OLD.state = 'pending' AND EXISTS (
  SELECT 1 FROM tenant_upload_grant_operations o WHERE o.client_id = NEW.client_id AND o.operation_id = NEW.created_operation_id AND o.grant_id = NEW.grant_id AND o.operation = 'issue' AND o.state = 'audited'))
BEGIN SELECT RAISE(ABORT, 'an upload grant activates only after its audit event is confirmed'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grants_no_delete BEFORE DELETE ON tenant_upload_grants
BEGIN SELECT RAISE(ABORT, 'an upload grant is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grant_operations_audit_only BEFORE UPDATE ON tenant_upload_grant_operations
WHEN NOT (OLD.state = 'recorded' AND NEW.state = 'audited' AND NEW.client_id = OLD.client_id AND NEW.operation_id = OLD.operation_id AND NEW.operation = OLD.operation
  AND NEW.actor_issuer = OLD.actor_issuer AND NEW.actor_subject = OLD.actor_subject AND NEW.actor_kind = OLD.actor_kind AND NEW.request = OLD.request
  AND NEW.grant_id = OLD.grant_id AND NEW.event_json = OLD.event_json AND NEW.event_digest = OLD.event_digest AND NEW.recorded_at = OLD.recorded_at)
BEGIN SELECT RAISE(ABORT, 'an upload operation only moves from recorded to audited'); END;
CREATE TRIGGER IF NOT EXISTS tenant_upload_grant_operations_no_delete BEFORE DELETE ON tenant_upload_grant_operations
BEGIN SELECT RAISE(ABORT, 'an upload operation is never deleted'); END;


-- src/lib/storage/cloud/migrations/0002_rs_verification_work.sql
-- NATIVE24: the verification work ledger. `verifyVersion` runs under a case read grant and reads and hashes package files and
-- originals, so before any R2 read it reserves its planned objects and bytes against its case's current window in one atomic
-- upsert (`verification.ts`). A reservation that would pass the window's bounds changes nothing and the call answers `busy`.
-- Only counts are kept; no verification result is cached across requests. Rows of earlier windows of the case are deleted
-- by the next reservation. Applied by the deployment after 0001, never by the Worker.
CREATE TABLE rs_verification_work (
  case_id TEXT NOT NULL REFERENCES rs_case,
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  objects INTEGER NOT NULL CHECK (objects >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (case_id, window_start)
);


-- src/lib/submissions/migrations/0001_submissions_intake.sql
-- GRS-137 hosted client intake: one client's per-deployment D1, namespace submissions_*. Unreleased; never applied to any D1.
-- An upload is one operation that supplies one file; a finalized upload becomes one immutable submission revision.
CREATE TABLE IF NOT EXISTS submissions_upload (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type = 'application/pdf'),
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- received: declared, no bytes acknowledged; stored: the original store acknowledged this operation's verified bytes;
  -- reserved: the revision below (its sequence, path, size and sha256) is durably recorded and the original may now be
  -- finalized, but the submission is not shown as final; finalized: the original is bound to the case and the revision is final.
  state TEXT NOT NULL CHECK (state IN ('received', 'stored', 'reserved', 'finalized')),
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  stored_at TEXT,
  PRIMARY KEY (client_id, case_id, operation_id),
  UNIQUE (client_id, case_id, asset_id)
);

CREATE TABLE IF NOT EXISTS submissions_revision (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_id TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count = 1),
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, revision_id),
  UNIQUE (client_id, case_id, sequence),
  UNIQUE (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES submissions_upload (client_id, case_id, operation_id)
);

CREATE TABLE IF NOT EXISTS submissions_file (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  path TEXT NOT NULL,
  -- the collision key: two paths that differ only by case are one path within a revision
  path_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, revision_id, path_key),
  FOREIGN KEY (client_id, case_id, revision_id) REFERENCES submissions_revision (client_id, case_id, revision_id)
);

-- Immutability. UPDATE and DELETE are refused by the triggers below. INSERT OR REPLACE and REPLACE conflict handling delete the
-- conflicting row without firing DELETE triggers (SQLite's recursive_triggers is off by default, and D1 is not asked to turn it
-- on), so BEFORE INSERT triggers refuse every insert that collides with an existing row on ANY unique key: primary key, the
-- (case, sequence), (case, operation) and (case, asset) keys, and the one file of a revision. BEFORE triggers run before the
-- conflict clause is applied, so no OR REPLACE / OR IGNORE form reaches an existing row. The request path never uses REPLACE;
-- this guards against an accidental statement or a later change, not against an administrator who drops the schema.
CREATE TRIGGER IF NOT EXISTS submissions_upload_insert_once BEFORE INSERT ON submissions_upload
  WHEN NEW.state <> 'received'
    OR EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (operation_id = NEW.operation_id OR asset_id = NEW.asset_id))
  BEGIN SELECT RAISE(ABORT, 'submission upload is declared once, as received'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_insert_once BEFORE INSERT ON submissions_revision
  WHEN EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (revision_id = NEW.revision_id OR sequence = NEW.sequence OR operation_id = NEW.operation_id))
    OR NEW.sequence <> (SELECT COALESCE(MAX(sequence), 0) + 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
    OR NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND state IN ('stored', 'reserved', 'finalized'))
  BEGIN SELECT RAISE(ABORT, 'submission revision is immutable: one per operation, the next sequence, from a stored upload'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_insert_once BEFORE INSERT ON submissions_file
  WHEN EXISTS (SELECT 1 FROM submissions_file WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND revision_id = NEW.revision_id)
  BEGIN SELECT RAISE(ABORT, 'submission file is immutable: a revision has its one file'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_matches_declaration BEFORE INSERT ON submissions_file
  WHEN NOT EXISTS (
    SELECT 1 FROM submissions_revision r JOIN submissions_upload u ON u.client_id = r.client_id AND u.case_id = r.case_id AND u.operation_id = r.operation_id
    WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.revision_id = NEW.revision_id
      AND u.path = NEW.path AND u.filename = NEW.filename AND u.media_type = NEW.media_type AND u.size = NEW.size AND u.sha256 = NEW.sha256 AND u.asset_id = NEW.asset_id)
  BEGIN SELECT RAISE(ABORT, 'submission file must match its declaration'); END;

-- A finalized revision never changes: no row of it is updated or deleted. A later file is a new revision.
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_update BEFORE UPDATE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_delete BEFORE DELETE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_update BEFORE UPDATE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_delete BEFORE DELETE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
-- A declaration's content never changes; only its state moves forward (received -> stored -> reserved -> finalized; stored -> finalized
-- is the one-step form of the last two). It never skips `stored`, and never moves back.
CREATE TRIGGER IF NOT EXISTS submissions_upload_declaration_fixed BEFORE UPDATE ON submissions_upload
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.path IS NOT OLD.path OR NEW.filename IS NOT OLD.filename OR NEW.media_type IS NOT OLD.media_type OR NEW.size IS NOT OLD.size OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject OR NEW.declared_at IS NOT OLD.declared_at
    OR (OLD.state = 'received' AND NEW.state NOT IN ('received', 'stored'))
    OR (OLD.state = 'stored' AND NEW.state = 'received') OR (OLD.state = 'reserved' AND NEW.state IN ('received', 'stored')) OR (OLD.state = 'finalized' AND NEW.state <> 'finalized')
  BEGIN SELECT RAISE(ABORT, 'submission upload declaration is fixed'); END;
-- An upload is reserved or finalized only once its revision is durably recorded: no original is made visible without it.
CREATE TRIGGER IF NOT EXISTS submissions_upload_needs_revision BEFORE UPDATE ON submissions_upload
  WHEN NEW.state IN ('reserved', 'finalized') AND OLD.state <> NEW.state
    AND NOT EXISTS (SELECT 1 FROM submissions_file f JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'a reserved upload needs its recorded revision'); END;
CREATE TRIGGER IF NOT EXISTS submissions_upload_no_delete BEFORE DELETE ON submissions_upload BEGIN SELECT RAISE(ABORT, 'submission upload is retained'); END;


-- src/lib/user-work/hosted/migrations/0001_uw_user_work.sql
-- GRS-117 hosted case user work, applied to each client's own D1 database by the deployment, never by the Worker.
-- Owned names: uw_*. No foreign key to any rs_*, native_audit_*, tenant_* or other owner's table. Unreleased: this file
-- may still be corrected in place until a first apply is recorded.
--
-- Threat boundary. The triggers below stop ordinary SQL from rebinding the client, rewriting an operation's recorded
-- outcome, or deleting a snapshot or a table definition by accident. They are plain SQLite triggers, not protection
-- against a SQL administrator who can DROP a trigger or table, or replace the database.

-- The one client this database belongs to and the schema version the adapter requires. Written only by trusted
-- provisioning (provisionD1UserWork), never from a request. A database without this row, with another client or with
-- another schema version refuses every user-work read and write.
CREATE TABLE uw_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 63),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  bound_at TEXT NOT NULL
);
CREATE TRIGGER uw_binding_client_fixed BEFORE UPDATE OF singleton, client_id, bound_at ON uw_binding
BEGIN SELECT RAISE(ABORT, 'uw_binding client is fixed'); END;
CREATE TRIGGER uw_binding_no_delete BEFORE DELETE ON uw_binding
BEGIN SELECT RAISE(ABORT, 'uw_binding cannot be deleted'); END;
CREATE TRIGGER uw_binding_no_downgrade BEFORE UPDATE OF schema_version ON uw_binding WHEN NEW.schema_version < OLD.schema_version
BEGIN SELECT RAISE(ABORT, 'uw_binding schema version never decreases'); END;

-- The first statement of every guarded batch inserts NULL here when the state it read has changed, so the NOT NULL
-- constraint fails the statement and rolls the whole batch back. A successful batch never inserts a row.
CREATE TABLE uw_batch_guard (token TEXT NOT NULL);

-- The case's user-work revision. Every write replaces it, so a batch guarded on the revision it read cannot overwrite
-- a concurrent writer. A case without a row is at revision 'revision-0'.
CREATE TABLE uw_case (
  case_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The idempotent operation ledger. One row per committed operation, written in the same batch as its data. The row
-- keeps the request digest (operation, payload and principal), the result and the audit event that must be
-- acknowledged before the caller sees success. Only audited_at may change, and only from NULL.
CREATE TABLE uw_operation (
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  result_json TEXT NOT NULL,
  prior_revision TEXT NOT NULL,
  revision TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audited_at TEXT,
  PRIMARY KEY (case_id, operation_id)
);
CREATE TRIGGER uw_operation_fixed BEFORE UPDATE OF case_id, operation_id, request_sha256, result_json, prior_revision, revision, event_json, created_at ON uw_operation
BEGIN SELECT RAISE(ABORT, 'uw_operation is append-only'); END;
CREATE TRIGGER uw_operation_audit_once BEFORE UPDATE OF audited_at ON uw_operation WHEN OLD.audited_at IS NOT NULL OR NEW.audited_at IS NULL
BEGIN SELECT RAISE(ABORT, 'uw_operation audit acknowledgement is recorded once'); END;
CREATE TRIGGER uw_operation_no_delete BEFORE DELETE ON uw_operation
BEGIN SELECT RAISE(ABORT, 'uw_operation cannot be deleted'); END;

-- Case Notes. The target is kept whole (target_json) and its anchor in columns: a document anchor is the results
-- version and ref at creation plus the original's SHA-256, never a ref alone, so a reused ref in another results
-- version cannot take the note over. A Note needs no published results version.
CREATE TABLE uw_note (
  case_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('case', 'document', 'analysis')),
  anchor_results_version TEXT,
  anchor_ref TEXT,
  anchor_sha256 TEXT,
  target_json TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (case_id, note_id)
);
CREATE INDEX uw_note_anchor ON uw_note (case_id, anchor_sha256);

-- Edits of seed rows (overlays), keyed by dataset and seed id and pinned to the seed digest they were made against.
CREATE TABLE uw_seed_overlay (
  case_id TEXT NOT NULL,
  dataset_key TEXT NOT NULL,
  seed_id TEXT NOT NULL,
  base_seed_sha256 TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (case_id, dataset_key, seed_id)
);

-- Register rows (time, cost and other independent stores).
CREATE TABLE uw_register_row (
  case_id TEXT NOT NULL,
  store TEXT NOT NULL,
  row_id TEXT NOT NULL,
  anchor_json TEXT,
  fields_json TEXT NOT NULL,
  fields_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (case_id, store, row_id)
);

-- Feature-defined user-work tables: the definition is data, not DDL, so no request ever changes the schema. A
-- definition is written once and never updated or deleted.
CREATE TABLE uw_table_definition (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audited_at TEXT
);
CREATE TRIGGER uw_table_definition_fixed BEFORE UPDATE OF name, owner, definition_json, event_json, created_at ON uw_table_definition
BEGIN SELECT RAISE(ABORT, 'uw_table_definition is append-only'); END;
CREATE TRIGGER uw_table_definition_no_delete BEFORE DELETE ON uw_table_definition
BEGIN SELECT RAISE(ABORT, 'uw_table_definition cannot be deleted'); END;
CREATE TRIGGER uw_table_definition_audit_once BEFORE UPDATE OF audited_at ON uw_table_definition WHEN OLD.audited_at IS NOT NULL OR NEW.audited_at IS NULL
BEGIN SELECT RAISE(ABORT, 'uw_table_definition audit acknowledgement is recorded once'); END;

-- Rows of feature-defined tables. The key is the table's primary key (canonical JSON), unique per table across cases,
-- so one case can never store a row under another case's key.
CREATE TABLE uw_table_row (
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  case_id TEXT NOT NULL,
  cells_json TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (table_name, row_key)
);
CREATE INDEX uw_table_row_case ON uw_table_row (case_id, table_name);

-- Pre-restore and other recovery snapshots: append-only, never updated, never deleted (no retention here).
CREATE TABLE uw_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audited_at TEXT
);
CREATE INDEX uw_snapshot_case ON uw_snapshot (case_id);
CREATE TRIGGER uw_snapshot_fixed BEFORE UPDATE OF snapshot_id, case_id, revision, snapshot_json, snapshot_sha256, event_json, created_at ON uw_snapshot
BEGIN SELECT RAISE(ABORT, 'uw_snapshot is append-only'); END;
CREATE TRIGGER uw_snapshot_audit_once BEFORE UPDATE OF audited_at ON uw_snapshot WHEN OLD.audited_at IS NOT NULL OR NEW.audited_at IS NULL
BEGIN SELECT RAISE(ABORT, 'uw_snapshot audit acknowledgement is recorded once'); END;
CREATE TRIGGER uw_snapshot_no_delete BEFORE DELETE ON uw_snapshot
BEGIN SELECT RAISE(ABORT, 'uw_snapshot cannot be deleted'); END;


-- src/lib/results-review/native/migrations/0001_native_candidate_import.sql
-- Native private processed-package import: one client's per-deployment D1, namespace native_*. Unreleased; never applied to any D1.
-- A private candidate is a staged results version (GRS-115) that an operator linked to the exact finalized submission it was
-- made from. Rows here never publish anything, never record a sign-off and never hold package bytes.
CREATE TABLE IF NOT EXISTS native_import_attempt (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'correction')),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  submission_revision_id TEXT NOT NULL,
  base_candidate_id TEXT,
  declared_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, operation_id),
  CHECK ((kind = 'correction') = (base_candidate_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS native_candidate (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  results_version TEXT NOT NULL CHECK (length(results_version) = 71 AND results_version LIKE 'sha256:%'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  input_revision_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('import', 'correction')),
  parent_candidate_id TEXT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, candidate_id),
  UNIQUE (client_id, case_id, results_version),
  UNIQUE (client_id, case_id, operation_id),
  CHECK ((origin = 'correction') = (parent_candidate_id IS NOT NULL)),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES native_import_attempt (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, parent_candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS native_import_link (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  submission_revision_id TEXT NOT NULL,
  -- SHA-256 of the exact persisted manifest bytes of the finalized submission revision (never the package inputRevision.id)
  submission_manifest_sha256 TEXT NOT NULL CHECK (length(submission_manifest_sha256) = 64),
  results_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  input_revision_id TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  -- SHA-256 of the canonical link, so a read can refuse a row that no longer matches what was written
  link_sha256 TEXT NOT NULL CHECK (length(link_sha256) = 64),
  PRIMARY KEY (client_id, case_id, link_id),
  UNIQUE (client_id, case_id, candidate_id),
  FOREIGN KEY (client_id, case_id, candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);

-- A correction supersedes exactly one current candidate. Any sign-off of the old candidate no longer names a current one.
CREATE TABLE IF NOT EXISTS native_candidate_supersession (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  old_candidate_id TEXT NOT NULL,
  new_candidate_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, old_candidate_id),
  UNIQUE (client_id, case_id, new_candidate_id),
  FOREIGN KEY (client_id, case_id, old_candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id),
  FOREIGN KEY (client_id, case_id, new_candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);

-- Before and after facts of each changed package file of a correction (the bytes themselves stay in the stored versions).
CREATE TABLE IF NOT EXISTS native_correction_change (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_sha256 TEXT,
  before_size INTEGER,
  after_sha256 TEXT NOT NULL CHECK (length(after_sha256) = 64),
  after_size INTEGER NOT NULL,
  PRIMARY KEY (client_id, case_id, candidate_id, path),
  FOREIGN KEY (client_id, case_id, candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);

-- Write-once. BEFORE INSERT triggers refuse every insert that collides with an existing row on ANY unique key, because
-- INSERT OR REPLACE / REPLACE conflict handling deletes the conflicting row without firing DELETE triggers (SQLite's
-- recursive_triggers is off by default and D1 is not asked to turn it on). BEFORE triggers run before the conflict clause is
-- applied, so no OR REPLACE / OR IGNORE form reaches an existing row. The request path never uses REPLACE; this guards
-- against an accidental statement or a later change, not against an administrator who drops the schema (the link digest
-- and the read-time check below are the second line).
CREATE TRIGGER IF NOT EXISTS native_attempt_insert_once BEFORE INSERT ON native_import_attempt
  WHEN EXISTS (SELECT 1 FROM native_import_attempt WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'import attempt is recorded once'); END;

CREATE TRIGGER IF NOT EXISTS native_candidate_insert_once BEFORE INSERT ON native_candidate
  WHEN EXISTS (SELECT 1 FROM native_candidate WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (candidate_id = NEW.candidate_id OR results_version = NEW.results_version OR operation_id = NEW.operation_id))
    OR NOT EXISTS (SELECT 1 FROM native_import_attempt WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND kind = NEW.origin)
    OR (NEW.origin = 'correction' AND (
      NOT EXISTS (SELECT 1 FROM native_import_attempt WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND base_candidate_id = NEW.parent_candidate_id)
      OR NOT EXISTS (SELECT 1 FROM native_import_link WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.parent_candidate_id)
      OR EXISTS (SELECT 1 FROM native_candidate_supersession WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND old_candidate_id = NEW.parent_candidate_id)))
  BEGIN SELECT RAISE(ABORT, 'candidate is immutable: one per results version and operation, from its recorded attempt; a correction names a current linked parent'); END;

CREATE TRIGGER IF NOT EXISTS native_link_insert_once BEFORE INSERT ON native_import_link
  WHEN EXISTS (SELECT 1 FROM native_import_link WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (link_id = NEW.link_id OR candidate_id = NEW.candidate_id))
    OR NOT EXISTS (
      SELECT 1 FROM native_candidate c JOIN native_import_attempt a ON a.client_id = c.client_id AND a.case_id = c.case_id AND a.operation_id = c.operation_id
      WHERE c.client_id = NEW.client_id AND c.case_id = NEW.case_id AND c.candidate_id = NEW.candidate_id
        AND c.results_version = NEW.results_version AND c.manifest_sha256 = NEW.manifest_sha256 AND c.input_revision_id = NEW.input_revision_id
        AND a.operator_issuer = NEW.operator_issuer AND a.operator_subject = NEW.operator_subject AND a.submission_revision_id = NEW.submission_revision_id)
  BEGIN SELECT RAISE(ABORT, 'import link is immutable: one per candidate, naming exactly its candidate, attempt operator and submission revision'); END;

CREATE TRIGGER IF NOT EXISTS native_supersession_insert_once BEFORE INSERT ON native_candidate_supersession
  WHEN EXISTS (SELECT 1 FROM native_candidate_supersession WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (old_candidate_id = NEW.old_candidate_id OR new_candidate_id = NEW.new_candidate_id))
    OR NOT EXISTS (SELECT 1 FROM native_candidate WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.new_candidate_id AND origin = 'correction' AND parent_candidate_id = NEW.old_candidate_id)
  BEGIN SELECT RAISE(ABORT, 'supersession is immutable: a correction supersedes exactly its parent, once'); END;

CREATE TRIGGER IF NOT EXISTS native_change_insert_once BEFORE INSERT ON native_correction_change
  WHEN EXISTS (SELECT 1 FROM native_correction_change WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id AND path = NEW.path)
    OR NOT EXISTS (SELECT 1 FROM native_candidate WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id AND origin = 'correction')
  BEGIN SELECT RAISE(ABORT, 'correction change is immutable and belongs to a correction candidate'); END;

CREATE TRIGGER IF NOT EXISTS native_attempt_no_update BEFORE UPDATE ON native_import_attempt BEGIN SELECT RAISE(ABORT, 'import attempt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_attempt_no_delete BEFORE DELETE ON native_import_attempt BEGIN SELECT RAISE(ABORT, 'import attempt is retained'); END;
CREATE TRIGGER IF NOT EXISTS native_candidate_no_update BEFORE UPDATE ON native_candidate BEGIN SELECT RAISE(ABORT, 'candidate is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_candidate_no_delete BEFORE DELETE ON native_candidate BEGIN SELECT RAISE(ABORT, 'candidate is retained'); END;
CREATE TRIGGER IF NOT EXISTS native_link_no_update BEFORE UPDATE ON native_import_link BEGIN SELECT RAISE(ABORT, 'import link is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_link_no_delete BEFORE DELETE ON native_import_link BEGIN SELECT RAISE(ABORT, 'import link is retained'); END;
CREATE TRIGGER IF NOT EXISTS native_supersession_no_update BEFORE UPDATE ON native_candidate_supersession BEGIN SELECT RAISE(ABORT, 'supersession is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_supersession_no_delete BEFORE DELETE ON native_candidate_supersession BEGIN SELECT RAISE(ABORT, 'supersession is retained'); END;
CREATE TRIGGER IF NOT EXISTS native_change_no_update BEFORE UPDATE ON native_correction_change BEGIN SELECT RAISE(ABORT, 'correction change is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_change_no_delete BEFORE DELETE ON native_correction_change BEGIN SELECT RAISE(ABORT, 'correction change is retained'); END;

-- Commit success provenance with the link, then acknowledge durable delivery separately. No authority is minted here.
-- Intents retain the original actor/session for exact idempotent delivery, and are never returned in candidate responses.
CREATE TABLE IF NOT EXISTS native_candidate_audit_intent (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL CHECK (length(event_sha256) = 64),
  PRIMARY KEY (client_id, case_id, candidate_id),
  UNIQUE (client_id, event_id),
  UNIQUE (client_id, case_id, candidate_id, event_id),
  FOREIGN KEY (client_id, case_id, candidate_id) REFERENCES native_import_link (client_id, case_id, candidate_id)
);
CREATE TABLE IF NOT EXISTS native_candidate_audit_settlement (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, candidate_id),
  FOREIGN KEY (client_id, case_id, candidate_id, event_id) REFERENCES native_candidate_audit_intent (client_id, case_id, candidate_id, event_id)
);
CREATE TRIGGER IF NOT EXISTS native_audit_intent_insert_once BEFORE INSERT ON native_candidate_audit_intent
  WHEN EXISTS (SELECT 1 FROM native_candidate_audit_intent WHERE client_id = NEW.client_id AND (event_id = NEW.event_id OR (case_id = NEW.case_id AND candidate_id = NEW.candidate_id)))
    OR NOT EXISTS (SELECT 1 FROM native_import_link WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
  BEGIN SELECT RAISE(ABORT, 'candidate audit intent is recorded once for a linked candidate'); END;
CREATE TRIGGER IF NOT EXISTS native_audit_settlement_insert_once BEFORE INSERT ON native_candidate_audit_settlement
  WHEN EXISTS (SELECT 1 FROM native_candidate_audit_settlement WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
    OR NOT EXISTS (SELECT 1 FROM native_candidate_audit_intent WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id AND event_id = NEW.event_id)
  BEGIN SELECT RAISE(ABORT, 'candidate audit settlement requires the exact committed intent, once'); END;
CREATE TRIGGER IF NOT EXISTS native_audit_intent_no_update BEFORE UPDATE ON native_candidate_audit_intent BEGIN SELECT RAISE(ABORT, 'candidate audit intent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_audit_intent_no_delete BEFORE DELETE ON native_candidate_audit_intent BEGIN SELECT RAISE(ABORT, 'candidate audit intent is retained'); END;
CREATE TRIGGER IF NOT EXISTS native_audit_settlement_no_update BEFORE UPDATE ON native_candidate_audit_settlement BEGIN SELECT RAISE(ABORT, 'candidate audit settlement is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_audit_settlement_no_delete BEFORE DELETE ON native_candidate_audit_settlement BEGIN SELECT RAISE(ABORT, 'candidate audit settlement is retained'); END;


-- src/lib/publication/hosted/migrations/0001_publication_ledger.sql
-- Native exact-version sign-off and publication ledger (ADR-0010): one client's per-deployment D1, namespace pub_*.
-- Unreleased; never applied to any D1. The publication pointer itself is GRS-115's rs_publication, changed only through
-- the injected storage publisher; this ledger records who signed off and published what, and is never a pointer.

-- One human sign-off of one exact candidate. Every identity column is bound at insert and never changes.
CREATE TABLE IF NOT EXISTS pub_signoff (
  signoff_id TEXT NOT NULL PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  submission_revision_id TEXT NOT NULL,
  submission_manifest_sha256 TEXT NOT NULL,
  results_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  package_input_revision_id TEXT NOT NULL,
  diagnostics_sha256 TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  snapshot_revision TEXT NOT NULL,
  -- JSON: sorted warning fingerprints of the candidate, and [{fingerprint, reason}] for exactly its new warnings
  warning_fingerprints TEXT NOT NULL,
  acknowledgements TEXT NOT NULL,
  signer_issuer TEXT NOT NULL,
  signer_subject TEXT NOT NULL,
  signer_kind TEXT NOT NULL CHECK (signer_kind IN ('client', 'staff')),
  prepared_by_issuer TEXT NOT NULL,
  prepared_by_subject TEXT NOT NULL,
  self_approval INTEGER NOT NULL CHECK (self_approval IN (0, 1)),
  signed_at TEXT NOT NULL,
  audit_event TEXT NOT NULL CHECK (json_valid(audit_event)),
  -- recorded: written, audit event not yet confirmed (not effective); audited: effective
  state TEXT NOT NULL CHECK (state IN ('recorded', 'audited')),
  invalidated_at TEXT,
  invalidated_reason TEXT,
  CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL)),
  -- a self-approval is exactly a sign-off by its preparer
  CHECK (self_approval = (signer_issuer = prepared_by_issuer AND signer_subject = prepared_by_subject))
);
CREATE INDEX IF NOT EXISTS pub_signoff_case ON pub_signoff (client_id, case_id, candidate_id);

-- One publish or withdraw operation, keyed by its operation id. It records the pointer change it asked for.
CREATE TABLE IF NOT EXISTS pub_operation (
  operation_id TEXT NOT NULL PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publish', 'withdraw')),
  signoff_id TEXT REFERENCES pub_signoff (signoff_id),
  results_version TEXT NOT NULL,
  expected_kind TEXT NOT NULL CHECK (expected_kind IN ('none', 'published', 'withdrawn')),
  expected_version TEXT,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('client', 'staff')),
  signed_identity TEXT CHECK (signed_identity IS NULL OR json_valid(signed_identity)),
  audit_event TEXT NOT NULL CHECK (json_valid(audit_event)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'refused', 'failed', 'audited')),
  reason TEXT,
  at TEXT NOT NULL,
  CHECK ((kind = 'publish') = (signoff_id IS NOT NULL)),
  CHECK ((kind = 'publish') = (signed_identity IS NOT NULL)),
  CHECK ((expected_kind = 'none') = (expected_version IS NULL))
);

-- Immutability. INSERT OR REPLACE deletes a conflicting row without firing DELETE triggers (recursive_triggers is off),
-- so BEFORE INSERT refuses any collision on a unique key; UPDATE allows only the listed transitions; DELETE is refused.
CREATE TRIGGER IF NOT EXISTS pub_signoff_insert_once BEFORE INSERT ON pub_signoff
  WHEN NEW.state <> 'recorded' OR NEW.invalidated_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM pub_signoff WHERE signoff_id = NEW.signoff_id OR operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'a sign-off is recorded once, as recorded'); END;
CREATE TRIGGER IF NOT EXISTS pub_signoff_update BEFORE UPDATE ON pub_signoff
  WHEN NEW.signoff_id IS NOT OLD.signoff_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.request_sha256 IS NOT OLD.request_sha256
    OR NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.link_id IS NOT OLD.link_id
    OR NEW.submission_revision_id IS NOT OLD.submission_revision_id OR NEW.submission_manifest_sha256 IS NOT OLD.submission_manifest_sha256
    OR NEW.results_version IS NOT OLD.results_version OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.package_input_revision_id IS NOT OLD.package_input_revision_id
    OR NEW.diagnostics_sha256 IS NOT OLD.diagnostics_sha256 OR NEW.validator_version IS NOT OLD.validator_version OR NEW.snapshot_revision IS NOT OLD.snapshot_revision
    OR NEW.warning_fingerprints IS NOT OLD.warning_fingerprints OR NEW.acknowledgements IS NOT OLD.acknowledgements
    OR NEW.signer_issuer IS NOT OLD.signer_issuer OR NEW.signer_subject IS NOT OLD.signer_subject OR NEW.signer_kind IS NOT OLD.signer_kind
    OR NEW.prepared_by_issuer IS NOT OLD.prepared_by_issuer OR NEW.prepared_by_subject IS NOT OLD.prepared_by_subject
    OR NEW.self_approval IS NOT OLD.self_approval OR NEW.signed_at IS NOT OLD.signed_at OR NEW.audit_event IS NOT OLD.audit_event
    -- state: recorded -> audited only
    OR (NEW.state IS NOT OLD.state AND NOT (OLD.state = 'recorded' AND NEW.state = 'audited'))
    -- invalidation: null -> set, once
    OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at IS NOT OLD.invalidated_at OR NEW.invalidated_reason IS NOT OLD.invalidated_reason))
  BEGIN SELECT RAISE(ABORT, 'a sign-off is immutable except recorded->audited and a single invalidation'); END;
CREATE TRIGGER IF NOT EXISTS pub_signoff_no_delete BEFORE DELETE ON pub_signoff
  BEGIN SELECT RAISE(ABORT, 'a sign-off is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS pub_operation_insert_once BEFORE INSERT ON pub_operation
  WHEN NEW.state <> 'pending' OR EXISTS (SELECT 1 FROM pub_operation WHERE operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'an operation is recorded once, as pending'); END;
CREATE TRIGGER IF NOT EXISTS pub_operation_update BEFORE UPDATE ON pub_operation
  WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.client_id IS NOT OLD.client_id
    OR NEW.case_id IS NOT OLD.case_id OR NEW.kind IS NOT OLD.kind OR NEW.signoff_id IS NOT OLD.signoff_id OR NEW.results_version IS NOT OLD.results_version
    OR NEW.expected_kind IS NOT OLD.expected_kind OR NEW.expected_version IS NOT OLD.expected_version
    OR NEW.signed_identity IS NOT OLD.signed_identity OR NEW.audit_event IS NOT OLD.audit_event
    OR NEW.actor_issuer IS NOT OLD.actor_issuer OR NEW.actor_subject IS NOT OLD.actor_subject OR NEW.actor_kind IS NOT OLD.actor_kind OR NEW.at IS NOT OLD.at
    -- pending|failed -> applied|refused|failed; applied -> audited; refused and audited are final
    OR NOT ((OLD.state IN ('pending', 'failed') AND NEW.state IN ('applied', 'refused', 'failed'))
         OR (OLD.state = 'applied' AND NEW.state = 'audited'))
  BEGIN SELECT RAISE(ABORT, 'an operation changes only along its recorded transitions'); END;
CREATE TRIGGER IF NOT EXISTS pub_operation_no_delete BEFORE DELETE ON pub_operation
  BEGIN SELECT RAISE(ABORT, 'an operation is never deleted'); END;


-- src/lib/publication/hosted/migrations/0002_atomic_publication.sql
-- Atomic publication on the SAME client D1 as GRS-114 grants, GRS-115 results and native candidate links.
-- Apply after their migrations (native_candidate_audit_{intent,settlement} from ebe3ed4b REQUIRED)
-- and 0001_publication_ledger.sql from fbf1c16f (audit_event/signed_identity required).
-- No Worker-side DDL. The parent must remove/disable any other rs_publication writer.
-- External Clerk is not in this transaction: see docs/acceptance/atomic-d1-publication.md.

-- Refuse installation without the candidate owner's durable-currentness fix; never assume unaudited links are current.
SELECT event_id FROM native_candidate_audit_settlement LIMIT 0;
SELECT audit_event, signed_identity FROM pub_operation LIMIT 0;
SELECT audit_event FROM pub_signoff LIMIT 0;

-- The reader exposes "d1:<generation>" as snapshotRevision. No ready/approved flag is stored here.
CREATE TABLE pub_candidate_generation (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (typeof(generation) = 'integer' AND generation >= 1),
  PRIMARY KEY (client_id, case_id, candidate_id),
  FOREIGN KEY (client_id, case_id, candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);
INSERT INTO pub_candidate_generation (client_id, case_id, candidate_id)
  SELECT client_id, case_id, candidate_id FROM native_import_link;
-- Pre-migration sign-offs never used this generation fence. They cannot silently become effective under it.
UPDATE pub_signoff SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), invalidated_reason = 'atomic-generation-migration'
  WHERE invalidated_at IS NULL;

CREATE TRIGGER pub_generation_insert_once BEFORE INSERT ON pub_candidate_generation
  WHEN NEW.generation <> 1
    OR EXISTS (SELECT 1 FROM pub_candidate_generation WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
    OR NOT EXISTS (SELECT 1 FROM native_import_link WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
  BEGIN SELECT RAISE(ABORT, 'publication generation starts once, from a linked candidate'); END;
CREATE TRIGGER pub_generation_update BEFORE UPDATE ON pub_candidate_generation
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.generation IS NOT OLD.generation + 1
  BEGIN SELECT RAISE(ABORT, 'publication generation only advances'); END;
CREATE TRIGGER pub_generation_no_delete BEFORE DELETE ON pub_candidate_generation
  BEGIN SELECT RAISE(ABORT, 'publication generation is retained'); END;
CREATE TRIGGER pub_generation_invalidate AFTER UPDATE ON pub_candidate_generation
  BEGIN
    UPDATE pub_signoff SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), invalidated_reason = 'candidate-dependency-changed'
      WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id AND invalidated_at IS NULL;
  END;
CREATE TRIGGER pub_generation_link AFTER INSERT ON native_import_link
  BEGIN INSERT INTO pub_candidate_generation (client_id, case_id, candidate_id) VALUES (NEW.client_id, NEW.case_id, NEW.candidate_id); END;
CREATE TRIGGER pub_generation_supersession AFTER INSERT ON native_candidate_supersession
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.old_candidate_id; END;

-- Optional local revocation fence. Record a positively observed revocation here before acknowledging it locally.
-- It does NOT represent a cache of active Clerk sessions, cannot grant authority, and cannot lock Clerk.
CREATE TABLE pub_session_revocation (
  client_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (client_id, issuer, session_id)
);
CREATE TRIGGER pub_session_revocation_once BEFORE INSERT ON pub_session_revocation
  WHEN EXISTS (SELECT 1 FROM pub_session_revocation WHERE client_id = NEW.client_id AND issuer = NEW.issuer AND session_id = NEW.session_id)
  BEGIN SELECT RAISE(ABORT, 'session revocation is recorded once'); END;
CREATE TRIGGER pub_session_revocation_no_update BEFORE UPDATE ON pub_session_revocation
  BEGIN SELECT RAISE(ABORT, 'session revocation is permanent'); END;
CREATE TRIGGER pub_session_revocation_no_delete BEFORE DELETE ON pub_session_revocation
  BEGIN SELECT RAISE(ABORT, 'session revocation is retained'); END;

-- Exactly the existing immutable intent, including the ORIGINAL human actor, audit session and event envelope.
-- JSON structural comparison in the receipt guard is key-order independent and array-order sensitive.
CREATE VIEW pub_durable_intent AS
  SELECT operation_id, client_id, case_id,
    json_object(
      'operationId', operation_id, 'requestSha256', request_sha256, 'clientId', client_id, 'caseId', case_id,
      'kind', kind, 'signoffId', signoff_id, 'resultsVersion', results_version,
      'expected', json(CASE WHEN expected_kind = 'none' THEN '{"kind":"none"}'
        ELSE json_object('kind', expected_kind, 'resultsVersion', expected_version) END),
      'actor', json_object('issuer', actor_issuer, 'subject', actor_subject, 'kind', actor_kind),
      'signedIdentity', json(signed_identity), 'auditEvent', json(audit_event), 'at', at
    ) AS intent_json
  FROM pub_operation;

CREATE TABLE pub_apply_receipt (
  operation_id TEXT NOT NULL PRIMARY KEY REFERENCES pub_operation (operation_id),
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND json_type(intent_json) = 'object'),
  -- Retry authority is separate from the immutable operation/audit identity. It cannot replace the original actor.
  authority_issuer TEXT NOT NULL,
  authority_subject TEXT NOT NULL,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('client', 'staff')),
  authority_session_id TEXT NOT NULL CHECK (length(authority_session_id) > 0),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pub_apply_receipt_case ON pub_apply_receipt (client_id, case_id, operation_id);
CREATE TRIGGER pub_receipt_no_update BEFORE UPDATE ON pub_apply_receipt
  BEGIN SELECT RAISE(ABORT, 'publication receipt is immutable'); END;
CREATE TRIGGER pub_receipt_no_delete BEFORE DELETE ON pub_apply_receipt
  BEGIN SELECT RAISE(ABORT, 'publication receipt is retained'); END;

CREATE TRIGGER pub_receipt_guard BEFORE INSERT ON pub_apply_receipt
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pub_apply_receipt WHERE operation_id = NEW.operation_id)
    THEN RAISE(ABORT, 'pub:receipt-exists') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM rs_storage_identity
    WHERE singleton = 1 AND client_id = NEW.client_id AND layout = 'clearcase.rs/1')
    THEN RAISE(ABORT, 'pub:forbidden') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pub_operation o JOIN pub_durable_intent d ON d.operation_id = o.operation_id
    WHERE o.operation_id = NEW.operation_id AND o.client_id = NEW.client_id AND o.case_id = NEW.case_id
      AND o.state IN ('pending', 'failed')
      AND o.actor_issuer = NEW.authority_issuer AND o.actor_subject = NEW.authority_subject AND o.actor_kind = NEW.authority_kind
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(NEW.intent_json)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(d.intent_json))
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(d.intent_json)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(NEW.intent_json)))
    THEN RAISE(ABORT, 'pub:intent-mismatch') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pub_session_revocation
    WHERE client_id = NEW.client_id AND issuer = NEW.authority_issuer AND session_id = NEW.authority_session_id)
    THEN RAISE(ABORT, 'pub:invalid-session') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tenant_case_grants g
    WHERE g.client_id = NEW.client_id AND g.scope = 'case' AND g.case_id = NEW.case_id
      AND g.issuer = NEW.authority_issuer AND g.subject = NEW.authority_subject AND g.principal_kind = NEW.authority_kind
      AND g.role = 'publisher' AND g.slot = 'publisher' AND g.state = 'active' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday('now')))
    THEN RAISE(ABORT, 'pub:forbidden') END;
  SELECT CASE WHEN json_extract(NEW.intent_json, '$.kind') = 'publish' AND NOT EXISTS (
    SELECT 1 FROM pub_signoff s
    JOIN native_candidate c ON c.client_id = s.client_id AND c.case_id = s.case_id AND c.candidate_id = s.candidate_id
    JOIN native_import_link l ON l.client_id = c.client_id AND l.case_id = c.case_id AND l.candidate_id = c.candidate_id
    JOIN pub_candidate_generation g ON g.client_id = c.client_id AND g.case_id = c.case_id AND g.candidate_id = c.candidate_id
    JOIN rs_results_version v ON v.version_id = c.results_version AND v.case_id = c.case_id
    WHERE s.signoff_id = json_extract(NEW.intent_json, '$.signoffId') AND s.client_id = NEW.client_id AND s.case_id = NEW.case_id
      AND s.state = 'audited' AND s.invalidated_at IS NULL
      AND s.results_version = json_extract(NEW.intent_json, '$.resultsVersion')
      AND s.candidate_id = json_extract(NEW.intent_json, '$.signedIdentity.candidateId')
      AND s.link_id = json_extract(NEW.intent_json, '$.signedIdentity.linkId')
      AND s.submission_revision_id = json_extract(NEW.intent_json, '$.signedIdentity.submissionRevisionId')
      AND s.submission_manifest_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.submissionManifestSha256')
      AND s.results_version = json_extract(NEW.intent_json, '$.signedIdentity.resultsVersion')
      AND s.manifest_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.manifestSha256')
      AND s.package_input_revision_id = json_extract(NEW.intent_json, '$.signedIdentity.packageInputRevisionId')
      AND s.diagnostics_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.diagnosticsSha256')
      AND s.validator_version = json_extract(NEW.intent_json, '$.signedIdentity.validatorVersion')
      AND s.snapshot_revision = json_extract(NEW.intent_json, '$.signedIdentity.snapshotRevision')
      AND s.snapshot_revision = 'd1:' || g.generation
      AND s.link_id = l.link_id AND s.submission_revision_id = l.submission_revision_id AND s.submission_manifest_sha256 = l.submission_manifest_sha256
      AND s.results_version = c.results_version AND s.manifest_sha256 = c.manifest_sha256 AND s.package_input_revision_id = c.input_revision_id
      AND l.results_version = c.results_version AND l.manifest_sha256 = c.manifest_sha256 AND l.input_revision_id = c.input_revision_id
      AND s.prepared_by_issuer = l.operator_issuer AND s.prepared_by_subject = l.operator_subject
      AND v.state = 'stored' AND v.verdict IN ('accept', 'report')
      AND v.manifest_sha256 = s.manifest_sha256 AND v.input_revision_id = s.package_input_revision_id
      AND v.diagnostics_sha256 = s.diagnostics_sha256 AND v.validator_version = s.validator_version
      AND EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
        ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
        WHERE ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id)
      AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession x WHERE x.client_id = c.client_id AND x.case_id = c.case_id AND x.old_candidate_id = c.candidate_id))
    THEN RAISE(ABORT, 'pub:signoff-stale') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM rs_results_version v
    WHERE v.version_id = json_extract(NEW.intent_json, '$.resultsVersion') AND v.case_id = NEW.case_id AND v.state = 'stored')
    OR (json_extract(NEW.intent_json, '$.kind') = 'publish' AND EXISTS (
      SELECT 1 FROM rs_version_withdrawal WHERE version_id = json_extract(NEW.intent_json, '$.resultsVersion')))
    OR (json_extract(NEW.intent_json, '$.kind') = 'withdraw' AND (
      json_extract(NEW.intent_json, '$.expected.kind') <> 'published'
      OR json_extract(NEW.intent_json, '$.expected.resultsVersion') IS NOT json_extract(NEW.intent_json, '$.resultsVersion')))
    THEN RAISE(ABORT, 'pub:version-refused') END;
  SELECT CASE WHEN NOT (
    (json_extract(NEW.intent_json, '$.expected.kind') = 'none' AND NOT EXISTS (SELECT 1 FROM rs_publication WHERE case_id = NEW.case_id))
    OR EXISTS (SELECT 1 FROM rs_publication p WHERE p.case_id = NEW.case_id
      AND p.state = json_extract(NEW.intent_json, '$.expected.kind')
      AND p.version_id = json_extract(NEW.intent_json, '$.expected.resultsVersion')))
    THEN RAISE(ABORT, 'pub:pointer-conflict') END;
END;

-- Trigger writes are part of the receipt INSERT statement, itself in a D1 batch transaction. No independent pointer CAS.
CREATE TRIGGER pub_receipt_apply AFTER INSERT ON pub_apply_receipt
BEGIN
  INSERT INTO rs_publication (case_id, state, version_id, previous_version_id)
    VALUES (NEW.case_id, CASE json_extract(NEW.intent_json, '$.kind') WHEN 'publish' THEN 'published' ELSE 'withdrawn' END,
      json_extract(NEW.intent_json, '$.resultsVersion'), NULL)
    ON CONFLICT (case_id) DO UPDATE SET state = excluded.state, version_id = excluded.version_id,
      previous_version_id = CASE WHEN excluded.state = 'published' THEN rs_publication.version_id ELSE rs_publication.previous_version_id END;
  INSERT INTO rs_version_withdrawal (version_id, case_id, withdrawn_at)
    SELECT json_extract(NEW.intent_json, '$.resultsVersion'), NEW.case_id, NEW.applied_at
      WHERE json_extract(NEW.intent_json, '$.kind') = 'withdraw'
      AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = json_extract(NEW.intent_json, '$.resultsVersion'));
  DELETE FROM rs_trusted_fingerprint WHERE case_id = NEW.case_id AND json_extract(NEW.intent_json, '$.kind') = 'publish';
  INSERT INTO rs_trusted_fingerprint (case_id, fingerprint)
    SELECT NEW.case_id, w.value FROM pub_signoff s, json_each(s.warning_fingerprints) w
      WHERE s.signoff_id = json_extract(NEW.intent_json, '$.signoffId') AND json_extract(NEW.intent_json, '$.kind') = 'publish';
END;

CREATE TRIGGER pub_generation_rs_package_file_insert AFTER INSERT ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_package_file_update AFTER UPDATE ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_package_file_delete AFTER DELETE ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_document_insert AFTER INSERT ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_document_update AFTER UPDATE ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_document_delete AFTER DELETE ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_asset_insert AFTER INSERT ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_asset_update AFTER UPDATE ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_asset_delete AFTER DELETE ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_seed_insert AFTER INSERT ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_seed_update AFTER UPDATE ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_seed_delete AFTER DELETE ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_preview_insert AFTER INSERT ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_preview_update AFTER UPDATE ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_preview_delete AFTER DELETE ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_version_insert AFTER INSERT ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_case_original_insert AFTER INSERT ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_generation_original_insert AFTER INSERT ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 = NEW.sha256); END;
CREATE TRIGGER pub_generation_case_original_update AFTER UPDATE ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_generation_original_update AFTER UPDATE ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 IN (OLD.sha256, NEW.sha256)); END;
CREATE TRIGGER pub_generation_case_original_delete AFTER DELETE ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;
CREATE TRIGGER pub_generation_original_delete AFTER DELETE ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 = OLD.sha256); END;

-- Keep/import bookkeeping alone does not change signed candidate content.
CREATE TRIGGER pub_generation_version_update AFTER UPDATE OF version_id, case_id, state, manifest_sha256, input_revision_id,
  verdict, validator_version, diagnostics_sha256, warning_fingerprints, read_model_sha256, overview, case_label,
  expected_documents, expected_assets, expected_seeds, expected_files ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version IN (OLD.version_id, NEW.version_id)); END;
CREATE TRIGGER pub_generation_version_delete AFTER DELETE ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version = OLD.version_id); END;

