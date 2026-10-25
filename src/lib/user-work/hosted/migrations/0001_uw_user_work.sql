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
