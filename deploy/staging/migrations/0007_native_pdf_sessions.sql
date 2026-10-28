-- ClearCase native scaled PDF evidence sessions increment 0008. Requires applied 0001, 0002, 0004, 0005, 0006 and 0007; 0003 remains reserved.
-- Additive: the viewer's 0004 session admission tables and their seals; viewer 0003 (content receipts) arrived in 0005.
-- src/lib/viewer/hosted/migrations/0004_pdf_evidence_sessions.sql
-- Scaled PDF evidence (real-export U9): admission for one batched browser session, on the client's raw primary D1.
-- Additive: no 0001-0003 table, trigger or row changes. A session renders several documents, each in its own browser
-- context, so it is admitted once with its own daily client ceiling; the single-file npr_reservations quota is untouched.
-- Like 0001 there is no refund, reset or retry path, and a session row is never evidence that anything rendered: the
-- per-document facts are npr_content_receipts rows. Applied after 0003_content_receipts.sql.
CREATE TABLE npr_pdf_session_days (
 client_id TEXT PRIMARY KEY,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 96),
 next_launch_ms INTEGER NOT NULL CHECK (next_launch_ms >= 0)
) STRICT, WITHOUT ROWID;
CREATE TABLE npr_pdf_sessions (
 token TEXT PRIMARY KEY,
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 results_version TEXT NOT NULL,
 renderer_version TEXT NOT NULL,
 -- sha256 of the ordered documents the session was admitted to render (asset, input digest, size, page set).
 manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 documents INTEGER NOT NULL CHECK (documents BETWEEN 1 AND 32),
 day INTEGER NOT NULL CHECK (day >= 0),
 started_ms INTEGER NOT NULL CHECK (started_ms >= 0 AND day = started_ms / 86400000),
 -- Worst case: configured session deadline + 2 s cleanup + the full 60 s default provider idle tail, even after success.
 lease_ms INTEGER NOT NULL CHECK (lease_ms BETWEEN 62001 AND 122000),
 client_limit INTEGER NOT NULL CHECK (client_limit BETWEEN 1 AND 96),
 CHECK (started_ms % 86400000 + lease_ms < 86400000)
) STRICT, WITHOUT ROWID;
CREATE INDEX npr_pdf_session_day ON npr_pdf_sessions(client_id, day);

CREATE TRIGGER npr_pdf_session_guard BEFORE INSERT ON npr_pdf_sessions BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM npr_pdf_sessions WHERE token = NEW.token)
  THEN RAISE(ABORT, 'native pdf session immutable') END;
 -- One session at a time per client, its lease surviving midnight and a killed Worker; a clock rollback never reopens a day.
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM npr_pdf_session_days WHERE client_id = NEW.client_id
   AND (day > NEW.day OR next_launch_ms > NEW.started_ms OR (day = NEW.day AND runs >= NEW.client_limit))
 ) THEN RAISE(ABORT, 'native pdf session admission refused') END;
END;
CREATE TRIGGER npr_pdf_session_apply AFTER INSERT ON npr_pdf_sessions BEGIN
 UPDATE npr_pdf_session_days SET day = NEW.day,
  runs = CASE WHEN day < NEW.day THEN 1 ELSE runs + 1 END,
  next_launch_ms = NEW.started_ms + NEW.lease_ms WHERE client_id = NEW.client_id;
 INSERT INTO npr_pdf_session_days (client_id, day, runs, next_launch_ms)
 SELECT NEW.client_id, NEW.day, 1, NEW.started_ms + NEW.lease_ms
 WHERE NOT EXISTS (SELECT 1 FROM npr_pdf_session_days WHERE client_id = NEW.client_id);
END;
CREATE TRIGGER npr_pdf_session_no_update BEFORE UPDATE ON npr_pdf_sessions BEGIN
 SELECT RAISE(ABORT, 'native pdf session immutable');
END;
CREATE TRIGGER npr_pdf_session_no_delete BEFORE DELETE ON npr_pdf_sessions BEGIN
 SELECT RAISE(ABORT, 'native pdf session immutable');
END;

-- The counter is only a monotonic projection of the append-only sessions: no REPLACE, UPSERT, deletion, refund or rollback.
CREATE TRIGGER npr_pdf_session_days_insert_guard BEFORE INSERT ON npr_pdf_session_days BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM npr_pdf_session_days WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native pdf session counter immutable identity') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_pdf_sessions WHERE client_id = NEW.client_id)
  OR NEW.runs != (SELECT count(*) FROM npr_pdf_sessions WHERE client_id = NEW.client_id AND day = NEW.day)
  OR NEW.next_launch_ms IS NOT (SELECT max(started_ms + lease_ms) FROM npr_pdf_sessions WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native pdf session counter projection refused') END;
END;
CREATE TRIGGER npr_pdf_session_days_update_guard BEFORE UPDATE ON npr_pdf_session_days BEGIN
 SELECT CASE WHEN NEW.client_id != OLD.client_id OR NEW.day < OLD.day
  OR (NEW.day = OLD.day AND NEW.runs < OLD.runs) OR NEW.next_launch_ms < OLD.next_launch_ms
  THEN RAISE(ABORT, 'native pdf session counter monotonic') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_pdf_sessions WHERE client_id = NEW.client_id)
  OR NEW.runs != (SELECT count(*) FROM npr_pdf_sessions WHERE client_id = NEW.client_id AND day = NEW.day)
  OR NEW.next_launch_ms IS NOT (SELECT max(started_ms + lease_ms) FROM npr_pdf_sessions WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native pdf session counter projection refused') END;
END;
CREATE TRIGGER npr_pdf_session_days_no_delete BEFORE DELETE ON npr_pdf_session_days BEGIN
 SELECT RAISE(ABORT, 'native pdf session counter immutable identity');
END;

