-- Private delivery traversal only. Install with the deployment's owned schema migrations, never in a request.
-- Cursors are not audit ACKs, grants, approvals, settlements or proof that an operation applied.
CREATE TABLE IF NOT EXISTS native_audit_recovery_cursor (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cases', 'candidate', 'signoff', 'operation')),
  after_at TEXT NOT NULL DEFAULT '',
  after_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  PRIMARY KEY (client_id, case_id, kind),
  CHECK ((kind = 'cases' AND case_id = '') OR (kind <> 'cases' AND length(case_id) > 0)),
  CHECK (after_id IS NOT NULL OR after_at = '')
);
