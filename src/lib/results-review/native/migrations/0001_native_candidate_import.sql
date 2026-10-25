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
