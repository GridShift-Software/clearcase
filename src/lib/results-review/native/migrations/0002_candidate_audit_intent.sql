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
