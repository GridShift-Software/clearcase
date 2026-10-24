-- GRS-116 native request audit log, applied to each client's own D1 database. No table here is shared between clients.
-- Owned names: native_audit_*. No foreign key to any rs_*, tenant_* or case table.

-- The one client this database belongs to. Written only by trusted provisioning (provisionAuditBinding), never from a
-- request. A database without this row refuses every audit append, find and query.
CREATE TABLE native_audit_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 63),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  bound_at TEXT NOT NULL
);
CREATE TRIGGER native_audit_binding_no_rebind BEFORE UPDATE OF client_id ON native_audit_binding
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: client_id is fixed'); END;
CREATE TRIGGER native_audit_binding_no_delete BEFORE DELETE ON native_audit_binding
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: binding is permanent'); END;

-- Append-only events. canonical holds the exact canonical JSON of the event envelope; sha256 is its digest. The other
-- columns are indexes over the same values, never a second source of truth.
CREATE TABLE native_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  envelope INTEGER NOT NULL CHECK (envelope = 1),
  action TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  case_id TEXT,
  version TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed', 'refused')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('anonymous', 'verified')),
  at TEXT NOT NULL,
  canonical TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
);
CREATE INDEX native_audit_events_case ON native_audit_events (client_id, case_id, seq);
CREATE INDEX native_audit_events_admin ON native_audit_events (client_id, seq) WHERE case_id IS NULL;

-- Every event belongs to the bound client; an unbound database accepts none.
CREATE TRIGGER native_audit_events_bound BEFORE INSERT ON native_audit_events
WHEN NOT EXISTS (SELECT 1 FROM native_audit_binding WHERE singleton = 1 AND client_id = NEW.client_id)
BEGIN SELECT RAISE(ABORT, 'native_audit_events: client not bound'); END;
-- Protected history: no update, no delete.
CREATE TRIGGER native_audit_events_no_update BEFORE UPDATE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
CREATE TRIGGER native_audit_events_no_delete BEFORE DELETE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
-- The row budget counter, kept in the same statement as the insert.
CREATE TRIGGER native_audit_events_count AFTER INSERT ON native_audit_events
BEGIN UPDATE native_audit_binding SET event_count = event_count + 1 WHERE singleton = 1; END;
