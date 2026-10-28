-- ClearCase native runtime increment; source 79c0ee92a858e55a12c727760e258ce8e293a86b
-- Requires unchanged 0001_native_alpha.sql; never replaces initial migration history.
-- src/lib/server/runtime/hosted/migrations/0001_audit_recovery_cursor.sql
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


-- src/lib/viewer/hosted/migrations/0001_preview_render_work.sql
-- Native PDF inspection launch admission, on the client's raw primary D1. Parent adds this migration to its assembler.
-- All counters and the exact-file reservation commit with ONE INSERT statement. No refunds, retry/reset operation or
-- reservation-derived "rendered" flag: a reservation is never evidence of canvas rendering. Immutable successful
-- exact-file render transcripts are separate facts, never candidate readiness/authority. No bytes, URL or screenshots.
CREATE TABLE npr_client_days (
 client_id TEXT PRIMARY KEY,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 4),
 next_launch_ms INTEGER NOT NULL CHECK (next_launch_ms >= 0)
) STRICT, WITHOUT ROWID;
CREATE TABLE npr_case_days (
 client_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 day INTEGER NOT NULL CHECK (day >= 0),
 runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 2),
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
 case_limit INTEGER NOT NULL CHECK (case_limit BETWEEN 1 AND 2),
 client_limit INTEGER NOT NULL CHECK (client_limit BETWEEN 1 AND 4 AND case_limit <= client_limit),
 CHECK (started_ms % 86400000 + lease_ms < 86400000)
) STRICT, WITHOUT ROWID;
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
) STRICT, WITHOUT ROWID;
CREATE TRIGGER npr_success_guard BEFORE INSERT ON npr_success_receipts BEGIN
 -- Exact idempotence is a no-op, not a delete/reinsert. No conflict strategy may alter any receipt field.
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM npr_success_receipts s WHERE s.binding_sha256 = NEW.binding_sha256
   AND s.reservation_token = NEW.reservation_token AND s.client_id = NEW.client_id AND s.case_id = NEW.case_id
   AND s.candidate_id = NEW.candidate_id AND s.results_version = NEW.results_version AND s.asset_id = NEW.asset_id
   AND s.input_sha256 = NEW.input_sha256 AND s.input_size = NEW.input_size AND s.renderer_version = NEW.renderer_version
   AND s.completed_ms = NEW.completed_ms AND s.pages = NEW.pages AND s.canvas_pixels = NEW.canvas_pixels
   AND s.transcript_json = NEW.transcript_json AND s.transcript_sha256 = NEW.transcript_sha256
 ) THEN RAISE(IGNORE) END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM npr_success_receipts s WHERE s.binding_sha256 = NEW.binding_sha256 OR s.reservation_token = NEW.reservation_token
   OR (s.client_id = NEW.client_id AND s.case_id = NEW.case_id AND s.candidate_id = NEW.candidate_id
    AND s.results_version = NEW.results_version AND s.asset_id = NEW.asset_id AND s.input_sha256 = NEW.input_sha256
    AND s.input_size = NEW.input_size AND s.renderer_version = NEW.renderer_version)
 ) THEN RAISE(ABORT, 'native render success immutable') END;
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

-- Mutable counters are only monotonic projections of append-only reservations. No REPLACE/UPSERT, deletion,
-- identity swap, clock/day rollback, same-day refund, lease shortening or fabricated future-day reset.
-- WITHOUT ROWID removes SQLite's other replacement identity; no recursive_triggers pragma is required.
CREATE TRIGGER npr_client_insert_guard BEFORE INSERT ON npr_client_days BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM npr_client_days WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native render client counter immutable identity') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_reservations WHERE client_id = NEW.client_id)
  OR NEW.runs != (SELECT count(*) FROM npr_reservations WHERE client_id = NEW.client_id AND day = NEW.day)
  OR NEW.next_launch_ms IS NOT (SELECT max(started_ms + lease_ms) FROM npr_reservations WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native render client counter projection refused') END;
END;
CREATE TRIGGER npr_client_update_guard BEFORE UPDATE ON npr_client_days BEGIN
 SELECT CASE WHEN NEW.client_id != OLD.client_id OR NEW.day < OLD.day
  OR (NEW.day = OLD.day AND NEW.runs < OLD.runs) OR NEW.next_launch_ms < OLD.next_launch_ms
  THEN RAISE(ABORT, 'native render client counter monotonic') END;
 SELECT CASE WHEN
  NEW.day IS NOT (SELECT max(day) FROM npr_reservations WHERE client_id = NEW.client_id)
  OR NEW.runs != (SELECT count(*) FROM npr_reservations WHERE client_id = NEW.client_id AND day = NEW.day)
  OR NEW.next_launch_ms IS NOT (SELECT max(started_ms + lease_ms) FROM npr_reservations WHERE client_id = NEW.client_id)
  THEN RAISE(ABORT, 'native render client counter projection refused') END;
END;
CREATE TRIGGER npr_client_no_delete BEFORE DELETE ON npr_client_days BEGIN
 SELECT RAISE(ABORT, 'native render client counter immutable identity');
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


-- src/lib/publication/hosted/migrations/0003_provenance_generation.sql
-- Publication provenance fencing, after storage, submissions, native import and publication 0001/0002.
-- Apply once during provisioning, NEVER in a request. No new tables or caller-supplied readiness.
-- Every permitted dependency write advances the existing monotonic generation in its own transaction.
-- Its existing invalidation trigger retires all affected sign-offs, including change-and-revert (ABA).
-- Case-level invalidation is deliberate: folder membership/path ambiguity and warning baselines are case facts.
-- Existing native/submission/receipt/ledger immutability triggers still reject UPDATE/DELETE/REPLACE of fixed evidence.
-- Invalidate pre-migration approvals: their provenance was not fenced.
UPDATE pub_candidate_generation SET generation = generation + 1;

CREATE TRIGGER pub_provenance_rs_original_upload_insert AFTER INSERT ON rs_original_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_rs_original_upload_update AFTER UPDATE ON rs_original_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_rs_original_upload_delete AFTER DELETE ON rs_original_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;

CREATE TRIGGER pub_provenance_submissions_upload_insert AFTER INSERT ON submissions_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_submissions_upload_update AFTER UPDATE ON submissions_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_submissions_upload_delete AFTER DELETE ON submissions_upload
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;

CREATE TRIGGER pub_provenance_rs_publication_insert AFTER INSERT ON rs_publication
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_rs_publication_update AFTER UPDATE ON rs_publication
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_rs_publication_delete AFTER DELETE ON rs_publication
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;

CREATE TRIGGER pub_provenance_rs_trusted_fingerprint_insert AFTER INSERT ON rs_trusted_fingerprint
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_rs_trusted_fingerprint_update AFTER UPDATE ON rs_trusted_fingerprint
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_rs_trusted_fingerprint_delete AFTER DELETE ON rs_trusted_fingerprint
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;

-- The admitted deployment identity is also a dependency, not a permanently cached authorization fact.
CREATE TRIGGER pub_provenance_identity_insert AFTER INSERT ON rs_storage_identity
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1; END;
CREATE TRIGGER pub_provenance_identity_update AFTER UPDATE ON rs_storage_identity
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1; END;
CREATE TRIGGER pub_provenance_identity_delete AFTER DELETE ON rs_storage_identity
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1; END;

-- Finalized submission links and paths are immutable, but new rows can alter folder membership.
-- submissions_upload is also fenced above: its stored_at and legal state transitions are mutable;
-- even another client's declaration can affect the folder's direct-original exclusion by case/asset.
CREATE TRIGGER pub_provenance_submissions_revision_insert AFTER INSERT ON submissions_revision
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_submissions_file_insert AFTER INSERT ON submissions_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;

-- WITH recursive_triggers OFF, REPLACE silently deletes conflict victims. These BEFORE INSERT fences
-- cover ALL unique keys that can evict a DIFFERENT provenance scope, before conflict handling.
-- Same-case replacements on upload/association/pointer/fingerprint tables are covered by AFTER INSERT.
-- Existing rs_original/case_original I/U/D triggers from 0002 continue to fence their ordinary writes.
CREATE TRIGGER pub_provenance_original_conflict BEFORE INSERT ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256
    WHERE c.case_id = pub_candidate_generation.case_id AND (o.sha256 = NEW.sha256 OR o.object_key = NEW.object_key)); END;
CREATE TRIGGER pub_provenance_version_conflict BEFORE INSERT ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id OR case_id IN (
    SELECT case_id FROM rs_results_version WHERE version_id = NEW.version_id OR import_seq = NEW.import_seq); END;

-- A baseline can reference a version OTHER than the candidate's. Fence all candidates in its case,
-- not only the candidate sharing that version. Also cover package_bytes, missing from 0002's list.
CREATE TRIGGER pub_provenance_version_update AFTER UPDATE OF version_id, case_id, state, manifest_sha256, input_revision_id,
  verdict, validator_version, diagnostics_sha256, warning_fingerprints, read_model_sha256, overview, case_label,
  expected_documents, expected_assets, expected_seeds, expected_files, package_bytes ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_version_delete AFTER DELETE ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;

CREATE TRIGGER pub_provenance_withdrawal_insert BEFORE INSERT ON rs_version_withdrawal
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (NEW.case_id) OR case_id IN (
    SELECT case_id FROM rs_results_version WHERE version_id IN (NEW.version_id)); END;
CREATE TRIGGER pub_provenance_withdrawal_update AFTER UPDATE ON rs_version_withdrawal
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id) OR case_id IN (
    SELECT case_id FROM rs_results_version WHERE version_id IN (OLD.version_id, NEW.version_id)); END;
CREATE TRIGGER pub_provenance_withdrawal_delete AFTER DELETE ON rs_version_withdrawal
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id) OR case_id IN (
    SELECT case_id FROM rs_results_version WHERE version_id IN (OLD.version_id)); END;
CREATE TRIGGER pub_provenance_withdrawal_conflict BEFORE INSERT ON rs_version_withdrawal
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (
    SELECT case_id FROM rs_version_withdrawal WHERE version_id = NEW.version_id); END;

-- The accepted baseline becomes trustworthy only when its durable operation is audited.
-- Sign-off identity/warnings are immutable; receipt insertion already requires its audited state.
-- Do NOT trigger on sign-off invalidation/settlement: that would invalidate a newly settled approval.
CREATE TRIGGER pub_provenance_operation_state AFTER UPDATE OF state ON pub_operation
  WHEN OLD.state IS NOT NEW.state AND (OLD.state = 'audited' OR NEW.state = 'audited')
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;

