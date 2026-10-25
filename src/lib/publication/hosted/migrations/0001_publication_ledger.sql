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
