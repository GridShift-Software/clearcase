-- GRS-116 native request audit log, applied to each client's own D1 database. No table here is shared between clients.
-- Owned names: native_audit_*. No foreign key to any rs_*, tenant_* or case table. Unreleased: this file may still be
-- corrected in place until a first apply is recorded.
--
-- Threat boundary. The constraints and triggers below stop ordinary SQL from rewriting history by accident or through
-- an unreviewed statement: UPDATE, DELETE, INSERT OR REPLACE (with or without recursive_triggers), rebinding the client
-- and resetting a counter. They are plain SQLite triggers, not PRAGMA settings. They are NOT protection against a SQL
-- administrator who can DROP a trigger or table, or replace the database; nothing here is tamper-proof.

-- The one client this database belongs to. Written only by trusted provisioning (provisionAuditBinding), never from a
-- request. A database without this row refuses every audit append, find and query. The counters are the capacity
-- ledger: one per event class (see the events table), so reads can never use up the budget of protected business events.
CREATE TABLE native_audit_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 63),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  denial_count INTEGER NOT NULL DEFAULT 0 CHECK (denial_count >= 0),
  denial_unlogged INTEGER NOT NULL DEFAULT 0 CHECK (denial_unlogged >= 0),
  bound_at TEXT NOT NULL
);
-- One row, once, with zeroed counters. Fires before any conflict handling, so INSERT OR REPLACE cannot swap the row.
CREATE TRIGGER native_audit_binding_once BEFORE INSERT ON native_audit_binding
WHEN EXISTS (SELECT 1 FROM native_audit_binding) OR NEW.event_count <> 0 OR NEW.read_count <> 0 OR NEW.denial_count <> 0 OR NEW.denial_unlogged <> 0
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: bound once, counters start at zero'); END;
CREATE TRIGGER native_audit_binding_no_rebind BEFORE UPDATE ON native_audit_binding
WHEN NEW.singleton <> OLD.singleton OR NEW.client_id <> OLD.client_id OR NEW.bound_at <> OLD.bound_at
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: client_id is fixed'); END;
-- A counter never decreases, and one statement raises the counters by at most one in total (the insert trigger below,
-- or the denial_unlogged note), so an arbitrary UPDATE cannot reset or jump a quota.
CREATE TRIGGER native_audit_binding_counters BEFORE UPDATE ON native_audit_binding
WHEN NEW.event_count < OLD.event_count OR NEW.read_count < OLD.read_count OR NEW.denial_count < OLD.denial_count OR NEW.denial_unlogged < OLD.denial_unlogged
  OR (NEW.event_count + NEW.read_count + NEW.denial_count + NEW.denial_unlogged) - (OLD.event_count + OLD.read_count + OLD.denial_count + OLD.denial_unlogged) > 1
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: counters only grow, by one'); END;
CREATE TRIGGER native_audit_binding_no_delete BEFORE DELETE ON native_audit_binding
BEGIN SELECT RAISE(ABORT, 'native_audit_binding: binding is permanent'); END;

-- Append-only events. canonical holds the exact canonical JSON of the event envelope; sha256 is its digest. The other
-- columns are indexes over the same values, never a second source of truth.
-- class separates capacity: 'protected' events are the business events producers append; 'read' is a served audit.read;
-- 'denial' is an audit.read that was refused or failed. Only 'protected' rows are charged to maxRows.
CREATE TABLE native_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  envelope INTEGER NOT NULL CHECK (envelope = 1),
  class TEXT NOT NULL DEFAULT 'protected' CHECK (class IN ('protected', 'read', 'denial')),
  actor_key TEXT,
  action TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  case_id TEXT,
  version TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed', 'refused')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('anonymous', 'verified')),
  at TEXT NOT NULL,
  canonical TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  CHECK (
    (class = 'protected' AND action <> 'audit.read')
    OR (class = 'read' AND action = 'audit.read' AND outcome = 'succeeded')
    OR (class = 'denial' AND action = 'audit.read' AND outcome IN ('denied', 'failed'))
  )
);
CREATE INDEX native_audit_events_case ON native_audit_events (client_id, case_id, seq);
CREATE INDEX native_audit_events_admin ON native_audit_events (client_id, seq) WHERE case_id IS NULL;
CREATE INDEX native_audit_events_denials ON native_audit_events (class, actor_key);

-- Every event belongs to the bound client; an unbound database accepts none.
CREATE TRIGGER native_audit_events_bound BEFORE INSERT ON native_audit_events
WHEN NOT EXISTS (SELECT 1 FROM native_audit_binding WHERE singleton = 1 AND client_id = NEW.client_id)
BEGIN SELECT RAISE(ABORT, 'native_audit_events: client not bound'); END;
-- An event id and a sequence number are used once. This fires before conflict handling, so INSERT OR REPLACE cannot swap
-- a stored row (REPLACE deletes without firing delete triggers unless recursive_triggers is on, so the guard is here).
CREATE TRIGGER native_audit_events_no_reuse BEFORE INSERT ON native_audit_events
WHEN EXISTS (SELECT 1 FROM native_audit_events WHERE event_id = NEW.event_id OR seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only, ids and sequence are never reused'); END;
-- Protected history: no update, no delete.
CREATE TRIGGER native_audit_events_no_update BEFORE UPDATE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
CREATE TRIGGER native_audit_events_no_delete BEFORE DELETE ON native_audit_events
BEGIN SELECT RAISE(ABORT, 'native_audit_events: append-only'); END;
-- The capacity counter of the event's class, kept in the same statement as the insert.
CREATE TRIGGER native_audit_events_count AFTER INSERT ON native_audit_events
BEGIN
  UPDATE native_audit_binding SET
    event_count = event_count + (NEW.class = 'protected'),
    read_count = read_count + (NEW.class = 'read'),
    denial_count = denial_count + (NEW.class = 'denial')
  WHERE singleton = 1;
END;
