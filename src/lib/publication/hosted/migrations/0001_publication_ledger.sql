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
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'refused', 'failed', 'audited')),
  reason TEXT,
  at TEXT NOT NULL,
  CHECK ((kind = 'publish') = (signoff_id IS NOT NULL)),
  CHECK ((expected_kind = 'none') = (expected_version IS NULL))
);

-- RED: no immutability triggers yet.
