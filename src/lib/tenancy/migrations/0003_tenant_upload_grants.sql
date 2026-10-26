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
