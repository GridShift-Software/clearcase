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
