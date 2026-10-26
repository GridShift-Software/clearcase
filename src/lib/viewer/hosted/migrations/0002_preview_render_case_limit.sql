-- Native PDF inspection: the per-case daily ceiling becomes 3; the client ceiling stays 4. Applied after
-- 0001_preview_render_work.sql, to the client's raw primary D1. This is an engineering capacity change only: it adds
-- no refund, reset, retry or cache path, and a reservation is still never evidence of rendering.
--
-- SQLite cannot change a CHECK constraint, so npr_reservations and npr_case_days are rebuilt. Every row and value is
-- copied back unchanged: tokens, binding hashes, starts, leases, each reservation's own case/client limits and every
-- counter. The only definition changes are case_limit 1..3 and runs 1..3; the client limit, lease bound and every
-- other CHECK are unchanged. The rebuild never renames a table: a rename re-resolves every trigger body naming it
-- (npr_success_guard and the client counter guards name npr_reservations). Dropping a table drops its own indexes
-- and triggers, so they are recreated here exactly as 0001 wrote them, after the copy-back: the copy is not an
-- admission and fires no counter projection. npr_success_receipts references npr_reservations(token), so foreign keys
-- are deferred to the end of the migration's one transaction (D1 runs each migration file as one), when every
-- success receipt must again name its reservation. There is deliberately no closing `PRAGMA defer_foreign_keys = off`:
-- setting the pragma discards the deferred violations counted so far, so an orphaned receipt would commit. The pragma
-- switches itself off at the end of the transaction. npr_client_days and npr_success_receipts are not touched.
PRAGMA defer_foreign_keys = on;
CREATE TABLE npr_reservations_0002 AS SELECT * FROM npr_reservations;
CREATE TABLE npr_case_days_0002 AS SELECT * FROM npr_case_days;
DROP TABLE npr_case_days;
DROP TABLE npr_reservations;
CREATE TABLE npr_case_days (
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 3),
 PRIMARY KEY (client_id, case_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE npr_reservations (
 token TEXT PRIMARY KEY,
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 results_version TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
 input_size INTEGER NOT NULL CHECK (input_size BETWEEN 1 AND 4000000),
 renderer_version TEXT NOT NULL,
 binding_sha256 TEXT NOT NULL CHECK (length(binding_sha256) = 64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
 day INTEGER NOT NULL CHECK (day >= 0),
 started_ms INTEGER NOT NULL CHECK (started_ms >= 0 AND day = started_ms / 86400000),
 -- Worst case: configured run deadline + 2 s cleanup + full 60 s default provider idle tail, even after success.
 lease_ms INTEGER NOT NULL CHECK (lease_ms BETWEEN 62001 AND 82000),
 case_limit INTEGER NOT NULL CHECK (case_limit BETWEEN 1 AND 3),
 client_limit INTEGER NOT NULL CHECK (client_limit BETWEEN 1 AND 4 AND case_limit <= client_limit),
 CHECK (started_ms % 86400000 + lease_ms < 86400000)
) STRICT, WITHOUT ROWID;
INSERT INTO npr_reservations (token, client_id, case_id, candidate_id, results_version, asset_id, input_sha256, input_size, renderer_version, binding_sha256, day, started_ms, lease_ms, case_limit, client_limit)
 SELECT token, client_id, case_id, candidate_id, results_version, asset_id, input_sha256, input_size, renderer_version, binding_sha256, day, started_ms, lease_ms, case_limit, client_limit FROM npr_reservations_0002;
INSERT INTO npr_case_days (client_id, case_id, day, runs)
 SELECT client_id, case_id, day, runs FROM npr_case_days_0002;
DROP TABLE npr_reservations_0002;
DROP TABLE npr_case_days_0002;
CREATE INDEX npr_reservation_day ON npr_reservations(client_id, day);
CREATE INDEX npr_reservation_case_day ON npr_reservations(client_id, case_id, day);

CREATE TRIGGER npr_reserve_guard BEFORE INSERT ON npr_reservations BEGIN
 -- BEFORE INSERT runs even for REPLACE, regardless of recursive_triggers; identities can never be recycled.
 SELECT CASE WHEN EXISTS (SELECT 1 FROM npr_reservations WHERE token = NEW.token)
  THEN RAISE(ABORT, 'native render reservation immutable') END;
 -- A clock rollback never reopens an older day. A lease survives midnight and failed/interrupted Workers.
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM npr_client_days WHERE client_id = NEW.client_id
   AND (day > NEW.day OR next_launch_ms > NEW.started_ms OR (day = NEW.day AND runs >= NEW.client_limit))
 ) THEN RAISE(ABORT, 'native render client admission refused') END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM npr_case_days WHERE client_id = NEW.client_id AND case_id = NEW.case_id
   AND (day > NEW.day OR (day = NEW.day AND runs >= NEW.case_limit))
 ) THEN RAISE(ABORT, 'native render case admission refused') END;
END;
CREATE TRIGGER npr_reserve_apply AFTER INSERT ON npr_reservations BEGIN
 -- Separate UPDATE/INSERT lets counter INSERT guards reject ALL replacements, including UPSERT.
 -- Each value must also equal the immutable reservation projection; callers cannot reset or refund it.
 UPDATE npr_client_days SET day = NEW.day,
  runs = CASE WHEN day < NEW.day THEN 1 ELSE runs + 1 END,
  next_launch_ms = NEW.started_ms + NEW.lease_ms WHERE client_id = NEW.client_id;
 INSERT INTO npr_client_days (client_id, day, runs, next_launch_ms)
 SELECT NEW.client_id, NEW.day, 1, NEW.started_ms + NEW.lease_ms
 WHERE NOT EXISTS (SELECT 1 FROM npr_client_days WHERE client_id = NEW.client_id);
 UPDATE npr_case_days SET day = NEW.day,
  runs = CASE WHEN day < NEW.day THEN 1 ELSE runs + 1 END WHERE client_id = NEW.client_id AND case_id = NEW.case_id;
 INSERT INTO npr_case_days (client_id, case_id, day, runs)
 SELECT NEW.client_id, NEW.case_id, NEW.day, 1
 WHERE NOT EXISTS (SELECT 1 FROM npr_case_days WHERE client_id = NEW.client_id AND case_id = NEW.case_id);
END;
CREATE TRIGGER npr_reservation_no_update BEFORE UPDATE ON npr_reservations BEGIN
 SELECT RAISE(ABORT, 'native render reservation immutable');
END;
CREATE TRIGGER npr_reservation_no_delete BEFORE DELETE ON npr_reservations BEGIN
 SELECT RAISE(ABORT, 'native render reservation immutable');
END;

CREATE TRIGGER npr_case_insert_guard BEFORE INSERT ON npr_case_days BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM npr_case_days WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
  THEN RAISE(ABORT, 'native render case counter immutable identity') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_reservations WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
  OR NEW.runs != (SELECT count(*) FROM npr_reservations WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND day = NEW.day)
  THEN RAISE(ABORT, 'native render case counter projection refused') END;
END;
CREATE TRIGGER npr_case_update_guard BEFORE UPDATE ON npr_case_days BEGIN
 SELECT CASE WHEN NEW.client_id != OLD.client_id OR NEW.case_id != OLD.case_id OR NEW.day < OLD.day
  OR (NEW.day = OLD.day AND NEW.runs < OLD.runs)
  THEN RAISE(ABORT, 'native render case counter monotonic') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_reservations WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
  OR NEW.runs != (SELECT count(*) FROM npr_reservations WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND day = NEW.day)
  THEN RAISE(ABORT, 'native render case counter projection refused') END;
END;
CREATE TRIGGER npr_case_no_delete BEFORE DELETE ON npr_case_days BEGIN
 SELECT RAISE(ABORT, 'native render case counter immutable identity');
END;
