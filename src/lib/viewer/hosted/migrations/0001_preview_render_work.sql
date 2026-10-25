-- Native PDF inspection launch admission, on the client's raw primary D1. Parent adds this migration to its assembler.
-- All counters and the exact-file reservation commit with ONE INSERT statement. No refunds, retry/reset operation or
-- reservation-derived "rendered" flag: a reservation is never evidence of canvas rendering. Immutable successful
-- exact-file render transcripts are separate facts, never candidate readiness/authority. No bytes, URL or screenshots.
CREATE TABLE npr_client_days (
 client_id TEXT PRIMARY KEY,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 4),
 next_launch_ms INTEGER NOT NULL CHECK (next_launch_ms >= 0)
) STRICT;
CREATE TABLE npr_case_days (
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 2),
 PRIMARY KEY (client_id, case_id)
) STRICT;
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
 case_limit INTEGER NOT NULL CHECK (case_limit BETWEEN 1 AND 2),
 client_limit INTEGER NOT NULL CHECK (client_limit BETWEEN 1 AND 4 AND case_limit <= client_limit),
 CHECK (started_ms % 86400000 + lease_ms < 86400000)
) STRICT;
CREATE INDEX npr_reservation_day ON npr_reservations(client_id, day);

CREATE TRIGGER npr_reserve_guard BEFORE INSERT ON npr_reservations BEGIN
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
 INSERT INTO npr_client_days (client_id, day, runs, next_launch_ms)
 VALUES (NEW.client_id, NEW.day, 1, NEW.started_ms + NEW.lease_ms)
 ON CONFLICT (client_id) DO UPDATE SET day = excluded.day,
  runs = CASE WHEN npr_client_days.day < excluded.day THEN 1 ELSE npr_client_days.runs + 1 END,
  next_launch_ms = excluded.next_launch_ms;
 INSERT INTO npr_case_days (client_id, case_id, day, runs)
 VALUES (NEW.client_id, NEW.case_id, NEW.day, 1)
 ON CONFLICT (client_id, case_id) DO UPDATE SET day = excluded.day,
  runs = CASE WHEN npr_case_days.day < excluded.day THEN 1 ELSE npr_case_days.runs + 1 END;
END;
CREATE TRIGGER npr_reservation_no_update BEFORE UPDATE ON npr_reservations BEGIN
 SELECT RAISE(ABORT, 'native render reservation immutable');
END;
CREATE TRIGGER npr_reservation_no_delete BEFORE DELETE ON npr_reservations BEGIN
 SELECT RAISE(ABORT, 'native render reservation immutable');
END;

-- Durable reusable byte-rendering fact only. Current scope authority, candidate generation and publication remain
-- parent checks. Never write this table for a failed/partial/timeout/unclean browser run. No TTL/reset/default cache.
CREATE TABLE npr_success_receipts (
 binding_sha256 TEXT PRIMARY KEY CHECK (length(binding_sha256) = 64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
 reservation_token TEXT NOT NULL UNIQUE REFERENCES npr_reservations(token),
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 results_version TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
 input_size INTEGER NOT NULL CHECK (input_size BETWEEN 1 AND 4000000),
 renderer_version TEXT NOT NULL,
 completed_ms INTEGER NOT NULL CHECK (completed_ms >= 0),
 pages INTEGER NOT NULL CHECK (pages BETWEEN 1 AND 8),
 canvas_pixels INTEGER NOT NULL CHECK (canvas_pixels BETWEEN 1 AND 4000000),
 transcript_json TEXT NOT NULL CHECK (length(transcript_json) BETWEEN 1 AND 8192),
 transcript_sha256 TEXT NOT NULL CHECK (length(transcript_sha256) = 64 AND transcript_sha256 NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version)
) STRICT;
CREATE TRIGGER npr_success_guard BEFORE INSERT ON npr_success_receipts BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM npr_reservations r WHERE r.token = NEW.reservation_token
   AND r.binding_sha256 = NEW.binding_sha256 AND r.client_id = NEW.client_id AND r.case_id = NEW.case_id
   AND r.candidate_id = NEW.candidate_id AND r.results_version = NEW.results_version AND r.asset_id = NEW.asset_id
   AND r.input_sha256 = NEW.input_sha256 AND r.input_size = NEW.input_size AND r.renderer_version = NEW.renderer_version
   AND NEW.completed_ms >= r.started_ms AND NEW.completed_ms <= r.started_ms + r.lease_ms - 60000
 ) THEN RAISE(ABORT, 'native render success has no exact reservation') END;
END;
CREATE TRIGGER npr_success_no_update BEFORE UPDATE ON npr_success_receipts BEGIN
 SELECT RAISE(ABORT, 'native render success immutable');
END;
CREATE TRIGGER npr_success_no_delete BEFORE DELETE ON npr_success_receipts BEGIN
 SELECT RAISE(ABORT, 'native render success immutable');
END;
