-- Native chunked import staging: one client's per-deployment D1, namespace native_import_*. Additive: no table of 0001 is altered.
-- A session records the package manifest an operator opened (the manifest bytes themselves are an R2 object keyed by this digest);
-- a staged file row records one package file whose bytes were verified against that manifest and stored. Rows are written once and
-- retained, so a resumed import can only ever find what a dead one had durably accepted. A stepped run (`complete`) keeps its position in
-- native_import_stage_run, the facts each step derived in native_import_stage_fact, and the sweep of its staged objects in native_import_cleanup.
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
  -- 1 when the verified bytes open with a PDF header: the fact a stepped import hands the validator for a preview it does not hold
  pdf INTEGER NOT NULL DEFAULT 0 CHECK (pdf IN (0, 1)),
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

-- The position of a stepped `complete`. One row per operation; a step takes the lease, does a bounded piece of work and moves the row
-- in one batch that holds the lease, the phase and the cursor it read, so a step that lost its lease or was repeated writes nothing.
-- `epoch` counts restarts after a refusal: the facts of an earlier epoch stay and are ignored.
CREATE TABLE IF NOT EXISTS native_import_stage_run (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'originals-a', 'validate-a', 'originals-b', 'begin', 'rows', 'objects', 'verify', 'readback', 'originals-d', 'final', 'done')),
  cursor TEXT NOT NULL,
  meta TEXT NOT NULL,
  outcome TEXT,
  steps INTEGER NOT NULL CHECK (steps >= 0),
  lease_id TEXT,
  lease_until_ms INTEGER NOT NULL CHECK (lease_until_ms >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES native_import_session (client_id, case_id, operation_id)
);

-- What a step derived and a later step reads: the selected originals, each pass's verified facts, the links, a pass's refusals.
CREATE TABLE IF NOT EXISTS native_import_stage_fact (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  pass TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, operation_id, epoch, pass, key),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES native_import_session (client_id, case_id, operation_id)
);

-- The sweep of a finished or abandoned import's staged objects, in bounded steps. `after_path` is the last staged file already dealt with.
CREATE TABLE IF NOT EXISTS native_import_cleanup (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('complete', 'abandoned')),
  after_path TEXT NOT NULL,
  swept INTEGER NOT NULL CHECK (swept >= 0),
  state TEXT NOT NULL CHECK (state IN ('sweeping', 'done')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES native_import_session (client_id, case_id, operation_id)
);

CREATE TRIGGER IF NOT EXISTS native_stage_run_insert_once BEFORE INSERT ON native_import_stage_run
  WHEN EXISTS (SELECT 1 FROM native_import_stage_run WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'stage run is written once'); END;
CREATE TRIGGER IF NOT EXISTS native_stage_run_moves_forward BEFORE UPDATE ON native_import_stage_run
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.epoch < OLD.epoch OR NEW.steps < OLD.steps
  BEGIN SELECT RAISE(ABORT, 'stage run only moves forward'); END;
CREATE TRIGGER IF NOT EXISTS native_stage_run_no_delete BEFORE DELETE ON native_import_stage_run BEGIN SELECT RAISE(ABORT, 'stage run is retained'); END;

CREATE TRIGGER IF NOT EXISTS native_stage_fact_insert_once BEFORE INSERT ON native_import_stage_fact
  WHEN EXISTS (SELECT 1 FROM native_import_stage_fact WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND epoch = NEW.epoch AND pass = NEW.pass AND key = NEW.key)
  BEGIN SELECT RAISE(ABORT, 'stage fact is written once'); END;
CREATE TRIGGER IF NOT EXISTS native_stage_fact_no_update BEFORE UPDATE ON native_import_stage_fact BEGIN SELECT RAISE(ABORT, 'stage fact is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_stage_fact_no_delete BEFORE DELETE ON native_import_stage_fact BEGIN SELECT RAISE(ABORT, 'stage fact is retained'); END;

CREATE TRIGGER IF NOT EXISTS native_cleanup_insert_once BEFORE INSERT ON native_import_cleanup
  WHEN EXISTS (SELECT 1 FROM native_import_cleanup WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'cleanup is recorded once'); END;
CREATE TRIGGER IF NOT EXISTS native_cleanup_moves_forward BEFORE UPDATE ON native_import_cleanup
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.reason IS NOT OLD.reason
    OR NEW.swept < OLD.swept OR NEW.after_path < OLD.after_path OR (OLD.state = 'done' AND NEW.state <> 'done')
  BEGIN SELECT RAISE(ABORT, 'cleanup only moves forward'); END;
CREATE TRIGGER IF NOT EXISTS native_cleanup_no_delete BEFORE DELETE ON native_import_cleanup BEGIN SELECT RAISE(ABORT, 'cleanup is retained'); END;
