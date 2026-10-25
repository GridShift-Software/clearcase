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
