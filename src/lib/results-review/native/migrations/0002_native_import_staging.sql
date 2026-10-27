-- Native chunked import staging: one client's per-deployment D1, namespace native_import_*. Additive: no table of 0001 is altered.
-- A session records the package manifest an operator opened (the manifest bytes themselves are an R2 object keyed by this digest);
-- a staged file row records one package file whose bytes were verified against that manifest and stored. Rows are written once and
-- retained, so a resumed import can only ever find what a dead one had durably accepted.
CREATE TABLE IF NOT EXISTS native_import_session (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  submission_revision_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  manifest_size INTEGER NOT NULL CHECK (manifest_size >= 1),
  results_version TEXT NOT NULL,
  expected_files INTEGER NOT NULL CHECK (expected_files >= 1),
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, operation_id)
);

CREATE TABLE IF NOT EXISTS native_import_staged_file (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, operation_id, path),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES native_import_session (client_id, case_id, operation_id)
);

CREATE TRIGGER IF NOT EXISTS native_session_insert_once BEFORE INSERT ON native_import_session
  WHEN EXISTS (SELECT 1 FROM native_import_session WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'import session is written once'); END;
CREATE TRIGGER IF NOT EXISTS native_session_no_update BEFORE UPDATE ON native_import_session BEGIN SELECT RAISE(ABORT, 'import session is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_session_no_delete BEFORE DELETE ON native_import_session BEGIN SELECT RAISE(ABORT, 'import session is retained'); END;
-- OR REPLACE would delete the old row without firing a delete trigger, so a second row for one path is refused here; the adapter inserts
-- only where no row exists, which makes a repeated or racing acceptance of the same file a no-op.
CREATE TRIGGER IF NOT EXISTS native_staged_file_insert_once BEFORE INSERT ON native_import_staged_file
  WHEN EXISTS (SELECT 1 FROM native_import_staged_file WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND path = NEW.path)
  BEGIN SELECT RAISE(ABORT, 'staged file is written once'); END;
CREATE TRIGGER IF NOT EXISTS native_staged_file_no_update BEFORE UPDATE ON native_import_staged_file BEGIN SELECT RAISE(ABORT, 'staged file is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_staged_file_no_delete BEFORE DELETE ON native_import_staged_file BEGIN SELECT RAISE(ABORT, 'staged file is retained'); END;
