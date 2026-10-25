-- Atomic publication on the SAME client D1 as GRS-114 grants, GRS-115 results and native candidate links.
-- Apply after their migrations (native_candidate_audit_{intent,settlement} from ebe3ed4b REQUIRED)
-- and 0001_publication_ledger.sql from fbf1c16f (audit_event/signed_identity required).
-- No Worker-side DDL. The parent must remove/disable any other rs_publication writer.
-- External Clerk is not in this transaction: see docs/acceptance/atomic-d1-publication.md.

-- Refuse installation without the candidate owner's durable-currentness fix; never assume unaudited links are current.
SELECT event_id FROM native_candidate_audit_settlement LIMIT 0;
SELECT audit_event, signed_identity FROM pub_operation LIMIT 0;
SELECT audit_event FROM pub_signoff LIMIT 0;

-- The reader exposes "d1:<generation>" as snapshotRevision. No ready/approved flag is stored here.
CREATE TABLE pub_candidate_generation (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (typeof(generation) = 'integer' AND generation >= 1),
  PRIMARY KEY (client_id, case_id, candidate_id),
  FOREIGN KEY (client_id, case_id, candidate_id) REFERENCES native_candidate (client_id, case_id, candidate_id)
);
INSERT INTO pub_candidate_generation (client_id, case_id, candidate_id)
  SELECT client_id, case_id, candidate_id FROM native_import_link;
-- Pre-migration sign-offs never used this generation fence. They cannot silently become effective under it.
UPDATE pub_signoff SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), invalidated_reason = 'atomic-generation-migration'
  WHERE invalidated_at IS NULL;

CREATE TRIGGER pub_generation_insert_once BEFORE INSERT ON pub_candidate_generation
  WHEN NEW.generation <> 1
    OR EXISTS (SELECT 1 FROM pub_candidate_generation WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
    OR NOT EXISTS (SELECT 1 FROM native_import_link WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id)
  BEGIN SELECT RAISE(ABORT, 'publication generation starts once, from a linked candidate'); END;
CREATE TRIGGER pub_generation_update BEFORE UPDATE ON pub_candidate_generation
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.generation IS NOT OLD.generation + 1
  BEGIN SELECT RAISE(ABORT, 'publication generation only advances'); END;
CREATE TRIGGER pub_generation_no_delete BEFORE DELETE ON pub_candidate_generation
  BEGIN SELECT RAISE(ABORT, 'publication generation is retained'); END;
CREATE TRIGGER pub_generation_invalidate AFTER UPDATE ON pub_candidate_generation
  BEGIN
    UPDATE pub_signoff SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), invalidated_reason = 'candidate-dependency-changed'
      WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.candidate_id AND invalidated_at IS NULL;
  END;
CREATE TRIGGER pub_generation_link AFTER INSERT ON native_import_link
  BEGIN INSERT INTO pub_candidate_generation (client_id, case_id, candidate_id) VALUES (NEW.client_id, NEW.case_id, NEW.candidate_id); END;
CREATE TRIGGER pub_generation_supersession AFTER INSERT ON native_candidate_supersession
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND candidate_id = NEW.old_candidate_id; END;

-- Optional local revocation fence. Record a positively observed revocation here before acknowledging it locally.
-- It does NOT represent a cache of active Clerk sessions, cannot grant authority, and cannot lock Clerk.
CREATE TABLE pub_session_revocation (
  client_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (client_id, issuer, session_id)
);
CREATE TRIGGER pub_session_revocation_once BEFORE INSERT ON pub_session_revocation
  WHEN EXISTS (SELECT 1 FROM pub_session_revocation WHERE client_id = NEW.client_id AND issuer = NEW.issuer AND session_id = NEW.session_id)
  BEGIN SELECT RAISE(ABORT, 'session revocation is recorded once'); END;
CREATE TRIGGER pub_session_revocation_no_update BEFORE UPDATE ON pub_session_revocation
  BEGIN SELECT RAISE(ABORT, 'session revocation is permanent'); END;
CREATE TRIGGER pub_session_revocation_no_delete BEFORE DELETE ON pub_session_revocation
  BEGIN SELECT RAISE(ABORT, 'session revocation is retained'); END;

-- Exactly the existing immutable intent, including the ORIGINAL human actor, audit session and event envelope.
-- JSON structural comparison in the receipt guard is key-order independent and array-order sensitive.
CREATE VIEW pub_durable_intent AS
  SELECT operation_id, client_id, case_id,
    json_object(
      'operationId', operation_id, 'requestSha256', request_sha256, 'clientId', client_id, 'caseId', case_id,
      'kind', kind, 'signoffId', signoff_id, 'resultsVersion', results_version,
      'expected', json(CASE WHEN expected_kind = 'none' THEN '{"kind":"none"}'
        ELSE json_object('kind', expected_kind, 'resultsVersion', expected_version) END),
      'actor', json_object('issuer', actor_issuer, 'subject', actor_subject, 'kind', actor_kind),
      'signedIdentity', json(signed_identity), 'auditEvent', json(audit_event), 'at', at
    ) AS intent_json
  FROM pub_operation;

CREATE TABLE pub_apply_receipt (
  operation_id TEXT NOT NULL PRIMARY KEY REFERENCES pub_operation (operation_id),
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND json_type(intent_json) = 'object'),
  -- Retry authority is separate from the immutable operation/audit identity. It cannot replace the original actor.
  authority_issuer TEXT NOT NULL,
  authority_subject TEXT NOT NULL,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('client', 'staff')),
  authority_session_id TEXT NOT NULL CHECK (length(authority_session_id) > 0),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pub_apply_receipt_case ON pub_apply_receipt (client_id, case_id, operation_id);
CREATE TRIGGER pub_receipt_no_update BEFORE UPDATE ON pub_apply_receipt
  BEGIN SELECT RAISE(ABORT, 'publication receipt is immutable'); END;
CREATE TRIGGER pub_receipt_no_delete BEFORE DELETE ON pub_apply_receipt
  BEGIN SELECT RAISE(ABORT, 'publication receipt is retained'); END;

CREATE TRIGGER pub_receipt_guard BEFORE INSERT ON pub_apply_receipt
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pub_apply_receipt WHERE operation_id = NEW.operation_id)
    THEN RAISE(ABORT, 'pub:receipt-exists') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM rs_storage_identity
    WHERE singleton = 1 AND client_id = NEW.client_id AND layout = 'clearcase.rs/1')
    THEN RAISE(ABORT, 'pub:forbidden') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pub_operation o JOIN pub_durable_intent d ON d.operation_id = o.operation_id
    WHERE o.operation_id = NEW.operation_id AND o.client_id = NEW.client_id AND o.case_id = NEW.case_id
      AND o.state IN ('pending', 'failed')
      AND o.actor_issuer = NEW.authority_issuer AND o.actor_subject = NEW.authority_subject AND o.actor_kind = NEW.authority_kind
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(NEW.intent_json)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(d.intent_json))
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(d.intent_json)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(NEW.intent_json)))
    THEN RAISE(ABORT, 'pub:intent-mismatch') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pub_session_revocation
    WHERE client_id = NEW.client_id AND issuer = NEW.authority_issuer AND session_id = NEW.authority_session_id)
    THEN RAISE(ABORT, 'pub:invalid-session') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tenant_case_grants g
    WHERE g.client_id = NEW.client_id AND g.scope = 'case' AND g.case_id = NEW.case_id
      AND g.issuer = NEW.authority_issuer AND g.subject = NEW.authority_subject AND g.principal_kind = NEW.authority_kind
      AND g.role = 'publisher' AND g.slot = 'publisher' AND g.state = 'active' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday('now')))
    THEN RAISE(ABORT, 'pub:forbidden') END;
  SELECT CASE WHEN json_extract(NEW.intent_json, '$.kind') = 'publish' AND NOT EXISTS (
    SELECT 1 FROM pub_signoff s
    JOIN native_candidate c ON c.client_id = s.client_id AND c.case_id = s.case_id AND c.candidate_id = s.candidate_id
    JOIN native_import_link l ON l.client_id = c.client_id AND l.case_id = c.case_id AND l.candidate_id = c.candidate_id
    JOIN pub_candidate_generation g ON g.client_id = c.client_id AND g.case_id = c.case_id AND g.candidate_id = c.candidate_id
    JOIN rs_results_version v ON v.version_id = c.results_version AND v.case_id = c.case_id
    WHERE s.signoff_id = json_extract(NEW.intent_json, '$.signoffId') AND s.client_id = NEW.client_id AND s.case_id = NEW.case_id
      AND s.state = 'audited' AND s.invalidated_at IS NULL
      AND s.results_version = json_extract(NEW.intent_json, '$.resultsVersion')
      AND s.candidate_id = json_extract(NEW.intent_json, '$.signedIdentity.candidateId')
      AND s.link_id = json_extract(NEW.intent_json, '$.signedIdentity.linkId')
      AND s.submission_revision_id = json_extract(NEW.intent_json, '$.signedIdentity.submissionRevisionId')
      AND s.submission_manifest_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.submissionManifestSha256')
      AND s.results_version = json_extract(NEW.intent_json, '$.signedIdentity.resultsVersion')
      AND s.manifest_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.manifestSha256')
      AND s.package_input_revision_id = json_extract(NEW.intent_json, '$.signedIdentity.packageInputRevisionId')
      AND s.diagnostics_sha256 = json_extract(NEW.intent_json, '$.signedIdentity.diagnosticsSha256')
      AND s.validator_version = json_extract(NEW.intent_json, '$.signedIdentity.validatorVersion')
      AND s.snapshot_revision = json_extract(NEW.intent_json, '$.signedIdentity.snapshotRevision')
      AND s.snapshot_revision = 'd1:' || g.generation
      AND s.link_id = l.link_id AND s.submission_revision_id = l.submission_revision_id AND s.submission_manifest_sha256 = l.submission_manifest_sha256
      AND s.results_version = c.results_version AND s.manifest_sha256 = c.manifest_sha256 AND s.package_input_revision_id = c.input_revision_id
      AND l.results_version = c.results_version AND l.manifest_sha256 = c.manifest_sha256 AND l.input_revision_id = c.input_revision_id
      AND s.prepared_by_issuer = l.operator_issuer AND s.prepared_by_subject = l.operator_subject
      AND v.state = 'stored' AND v.verdict IN ('accept', 'report')
      AND v.manifest_sha256 = s.manifest_sha256 AND v.input_revision_id = s.package_input_revision_id
      AND v.diagnostics_sha256 = s.diagnostics_sha256 AND v.validator_version = s.validator_version
      AND EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
        ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
        WHERE ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id)
      AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession x WHERE x.client_id = c.client_id AND x.case_id = c.case_id AND x.old_candidate_id = c.candidate_id))
    THEN RAISE(ABORT, 'pub:signoff-stale') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM rs_results_version v
    WHERE v.version_id = json_extract(NEW.intent_json, '$.resultsVersion') AND v.case_id = NEW.case_id AND v.state = 'stored')
    OR (json_extract(NEW.intent_json, '$.kind') = 'publish' AND EXISTS (
      SELECT 1 FROM rs_version_withdrawal WHERE version_id = json_extract(NEW.intent_json, '$.resultsVersion')))
    OR (json_extract(NEW.intent_json, '$.kind') = 'withdraw' AND (
      json_extract(NEW.intent_json, '$.expected.kind') <> 'published'
      OR json_extract(NEW.intent_json, '$.expected.resultsVersion') IS NOT json_extract(NEW.intent_json, '$.resultsVersion')))
    THEN RAISE(ABORT, 'pub:version-refused') END;
  SELECT CASE WHEN NOT (
    (json_extract(NEW.intent_json, '$.expected.kind') = 'none' AND NOT EXISTS (SELECT 1 FROM rs_publication WHERE case_id = NEW.case_id))
    OR EXISTS (SELECT 1 FROM rs_publication p WHERE p.case_id = NEW.case_id
      AND p.state = json_extract(NEW.intent_json, '$.expected.kind')
      AND p.version_id = json_extract(NEW.intent_json, '$.expected.resultsVersion')))
    THEN RAISE(ABORT, 'pub:pointer-conflict') END;
END;

-- Trigger writes are part of the receipt INSERT statement, itself in a D1 batch transaction. No independent pointer CAS.
CREATE TRIGGER pub_receipt_apply AFTER INSERT ON pub_apply_receipt
BEGIN
  INSERT INTO rs_publication (case_id, state, version_id, previous_version_id)
    VALUES (NEW.case_id, CASE json_extract(NEW.intent_json, '$.kind') WHEN 'publish' THEN 'published' ELSE 'withdrawn' END,
      json_extract(NEW.intent_json, '$.resultsVersion'), NULL)
    ON CONFLICT (case_id) DO UPDATE SET state = excluded.state, version_id = excluded.version_id,
      previous_version_id = CASE WHEN excluded.state = 'published' THEN rs_publication.version_id ELSE rs_publication.previous_version_id END;
  INSERT INTO rs_version_withdrawal (version_id, case_id, withdrawn_at)
    SELECT json_extract(NEW.intent_json, '$.resultsVersion'), NEW.case_id, NEW.applied_at
      WHERE json_extract(NEW.intent_json, '$.kind') = 'withdraw'
      AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = json_extract(NEW.intent_json, '$.resultsVersion'));
  DELETE FROM rs_trusted_fingerprint WHERE case_id = NEW.case_id AND json_extract(NEW.intent_json, '$.kind') = 'publish';
  INSERT INTO rs_trusted_fingerprint (case_id, fingerprint)
    SELECT NEW.case_id, w.value FROM pub_signoff s, json_each(s.warning_fingerprints) w
      WHERE s.signoff_id = json_extract(NEW.intent_json, '$.signoffId') AND json_extract(NEW.intent_json, '$.kind') = 'publish';
END;

CREATE TRIGGER pub_generation_rs_package_file_insert AFTER INSERT ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_package_file_update AFTER UPDATE ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_package_file_delete AFTER DELETE ON rs_package_file
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_document_insert AFTER INSERT ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_document_update AFTER UPDATE ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_document_delete AFTER DELETE ON rs_document
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_asset_insert AFTER INSERT ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_asset_update AFTER UPDATE ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_asset_delete AFTER DELETE ON rs_asset
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_seed_insert AFTER INSERT ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_seed_update AFTER UPDATE ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_seed_delete AFTER DELETE ON rs_seed
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_rs_preview_insert AFTER INSERT ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_rs_preview_update AFTER UPDATE ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version IN (OLD.version_id, NEW.version_id)); END;

CREATE TRIGGER pub_generation_rs_preview_delete AFTER DELETE ON rs_preview
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id AND c.results_version = OLD.version_id); END;

CREATE TRIGGER pub_generation_version_insert AFTER INSERT ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version = NEW.version_id); END;

CREATE TRIGGER pub_generation_case_original_insert AFTER INSERT ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_generation_original_insert AFTER INSERT ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 = NEW.sha256); END;
CREATE TRIGGER pub_generation_case_original_update AFTER UPDATE ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_generation_original_update AFTER UPDATE ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 IN (OLD.sha256, NEW.sha256)); END;
CREATE TRIGGER pub_generation_case_original_delete AFTER DELETE ON rs_case_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = OLD.case_id; END;
CREATE TRIGGER pub_generation_original_delete AFTER DELETE ON rs_original
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE EXISTS (
    SELECT 1 FROM rs_case_original co WHERE co.case_id = pub_candidate_generation.case_id AND co.sha256 = OLD.sha256); END;

-- Keep/import bookkeeping alone does not change signed candidate content.
CREATE TRIGGER pub_generation_version_update AFTER UPDATE OF version_id, case_id, state, manifest_sha256, input_revision_id,
  verdict, validator_version, diagnostics_sha256, warning_fingerprints, read_model_sha256, overview, case_label,
  expected_documents, expected_assets, expected_seeds, expected_files ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version IN (OLD.version_id, NEW.version_id)); END;
CREATE TRIGGER pub_generation_version_delete AFTER DELETE ON rs_results_version
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1
    WHERE EXISTS (SELECT 1 FROM native_candidate c WHERE c.client_id = pub_candidate_generation.client_id
      AND c.case_id = pub_candidate_generation.case_id AND c.candidate_id = pub_candidate_generation.candidate_id
      AND c.results_version = OLD.version_id); END;
