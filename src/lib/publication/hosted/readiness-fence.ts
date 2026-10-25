import type { CaseId, ClientId, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { canonicalJson } from '../../case-package/canonical.ts';
import type { PublicationD1Database } from './d1-publisher.ts';
import type { CandidateSnapshot, SignoffRecord } from './ports.ts';

export interface ReadinessObservation {
  clientId: ClientId;
  caseId: CaseId;
  principal: Principal;
  sessionId: SessionId;
  snapshot: CandidateSnapshot;
  signoff: SignoffRecord | null;
}
export type ReadinessFenceResult = 'current' | 'stale' | 'forbidden' | 'invalid-session' | 'unavailable';
/** Trusted composition only. No callback allows or cached authorization decisions. */
export interface ReadinessFence {
  readonly protocol: 'coherent-readiness/1';
  check(observation: ReadinessObservation): Promise<ReadinessFenceResult>;
}

/**
 * One SELECT on the primary is the linearization point, NOT a lock held through response delivery or Clerk.
 * Requires the existing atomic-publication migration and generation-fenced CandidateReader on this SAME DB.
 * Every snapshot dependency must be immutable or advance pub_candidate_generation in its write transaction.
 * Baseline is compared directly (its table does not advance that generation); ledger state and local authority
 * are checked in this statement too. A missing schema/transport/result fails closed. No writes or migrations.
 */
export function d1ReadinessFence(options: { db: PublicationD1Database; clientId: ClientId }): ReadinessFence {
  return { protocol: 'coherent-readiness/1', async check(observation) {
    const { db, clientId } = options;
    if (!clientId || observation.clientId !== clientId || observation.principal.kind !== 'staff'
      || !observation.sessionId || typeof db?.withSession !== 'function'
      || observation.snapshot.link.clientId !== clientId || observation.snapshot.link.caseId !== observation.caseId
      || observation.snapshot.link.candidate.clientId !== clientId || observation.snapshot.link.candidate.caseId !== observation.caseId) return 'unavailable';
    // Capture all caller-owned values before the sole storage await.
    const { caseId, principal, sessionId } = observation;
    const snapshot = canonicalJson(observation.snapshot), signoff = canonicalJson(observation.signoff);
    const row = await db.withSession('first-primary').prepare(`
      WITH o AS (SELECT ? AS client_id, ? AS case_id, ? AS issuer, ? AS subject, ? AS session_id,
        json(?) AS snapshot, json(?) AS signoff),
      grants AS (SELECT g.* FROM tenant_case_grants g, o
        WHERE g.client_id = o.client_id AND g.scope = 'case' AND g.case_id = o.case_id
          AND g.issuer = o.issuer AND g.subject = o.subject AND g.principal_kind = 'staff'
          AND g.state = 'active' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday('now'))),
      signed AS (SELECT json_object(
        'signoffId', s.signoff_id, 'operationId', s.operation_id, 'requestSha256', s.request_sha256,
        'clientId', s.client_id, 'caseId', s.case_id, 'candidateId', s.candidate_id, 'linkId', s.link_id,
        'submissionRevisionId', s.submission_revision_id, 'submissionManifestSha256', s.submission_manifest_sha256,
        'resultsVersion', s.results_version, 'manifestSha256', s.manifest_sha256,
        'packageInputRevisionId', s.package_input_revision_id, 'diagnosticsSha256', s.diagnostics_sha256,
        'validatorVersion', s.validator_version, 'snapshotRevision', s.snapshot_revision,
        'warningFingerprints', json(s.warning_fingerprints), 'acknowledgements', json(s.acknowledgements),
        'signer', json_object('issuer', s.signer_issuer, 'subject', s.signer_subject, 'kind', s.signer_kind),
        'preparedBy', json_object('issuer', s.prepared_by_issuer, 'subject', s.prepared_by_subject),
        'selfApproval', json(CASE s.self_approval WHEN 1 THEN 'true' ELSE 'false' END),
        'signedAt', s.signed_at, 'auditEvent', json(s.audit_event), 'state', s.state,
        'invalidatedAt', s.invalidated_at, 'invalidatedReason', s.invalidated_reason) AS record
        FROM pub_signoff s, o WHERE s.client_id = o.client_id AND s.case_id = o.case_id
          AND s.signoff_id = json_extract(o.signoff, '$.signoffId')
          AND s.candidate_id = json_extract(o.snapshot, '$.link.candidate.candidateId'))
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM rs_storage_identity i WHERE i.singleton = 1
          AND i.client_id = o.client_id AND i.layout = 'clearcase.rs/1') THEN 'unavailable'
        WHEN EXISTS (SELECT 1 FROM pub_session_revocation r WHERE r.client_id = o.client_id
          AND r.issuer = o.issuer AND r.session_id = o.session_id) THEN 'invalid-session'
        WHEN NOT EXISTS (SELECT 1 FROM rs_case WHERE case_id = o.case_id)
          OR NOT EXISTS (SELECT 1 FROM grants WHERE role = 'publisher' AND slot = 'publisher')
          OR NOT EXISTS (SELECT 1 FROM grants WHERE role IN ('viewer', 'editor') AND slot = 'content') THEN 'forbidden'
        WHEN NOT EXISTS (
          SELECT 1 FROM pub_candidate_generation g
          JOIN native_candidate c USING (client_id, case_id, candidate_id)
          JOIN native_import_link l USING (client_id, case_id, candidate_id)
          JOIN rs_results_version v ON v.version_id = c.results_version AND v.case_id = c.case_id
          WHERE g.client_id = o.client_id AND g.case_id = o.case_id
            AND g.candidate_id = json_extract(o.snapshot, '$.link.candidate.candidateId')
            AND 'd1:' || g.generation = json_extract(o.snapshot, '$.snapshotRevision')
            AND l.link_id = json_extract(o.snapshot, '$.link.linkId')
            AND l.submission_revision_id = json_extract(o.snapshot, '$.link.submissionRevisionId')
            AND l.submission_manifest_sha256 = json_extract(o.snapshot, '$.link.submissionManifestSha256')
            AND c.results_version = json_extract(o.snapshot, '$.link.candidate.resultsVersion')
            AND c.manifest_sha256 = json_extract(o.snapshot, '$.link.candidate.manifestSha256')
            AND c.input_revision_id = json_extract(o.snapshot, '$.link.candidate.packageInputRevisionId')
            AND l.operator_issuer = json_extract(o.snapshot, '$.preparedBy.issuer')
            AND l.operator_subject = json_extract(o.snapshot, '$.preparedBy.subject')
            AND v.state = 'stored' AND v.manifest_sha256 = c.manifest_sha256 AND v.input_revision_id = c.input_revision_id
            AND v.verdict = json_extract(o.snapshot, '$.validation.verdict')
            AND v.validator_version = json_extract(o.snapshot, '$.validation.validatorVersion')
            AND v.diagnostics_sha256 = json_extract(o.snapshot, '$.validation.diagnosticsSha256')
            AND NOT EXISTS (SELECT value FROM json_each(v.warning_fingerprints)
              EXCEPT SELECT value FROM json_each(o.snapshot, '$.validation.warningFingerprints'))
            AND NOT EXISTS (SELECT value FROM json_each(o.snapshot, '$.validation.warningFingerprints')
              EXCEPT SELECT value FROM json_each(v.warning_fingerprints))
            AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal w WHERE w.version_id = v.version_id)
            AND EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
              USING (client_id, case_id, candidate_id, event_id)
              WHERE ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id)
            AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession ns
              WHERE ns.client_id = c.client_id AND ns.case_id = c.case_id AND ns.old_candidate_id = c.candidate_id)
        ) THEN 'stale'
        WHEN EXISTS (SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = o.case_id
          EXCEPT SELECT value FROM json_each(o.snapshot, '$.trustedBaseline'))
          OR EXISTS (SELECT value FROM json_each(o.snapshot, '$.trustedBaseline')
            EXCEPT SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = o.case_id) THEN 'stale'
        WHEN json_type(o.signoff) <> 'null' AND NOT EXISTS (SELECT 1 FROM signed
          WHERE NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(signed.record)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(o.signoff))
          AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(o.signoff)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(signed.record))) THEN 'stale'
        ELSE 'current' END AS verdict FROM o
    `).bind(clientId, caseId, principal.issuer, principal.subject, sessionId, snapshot, signoff)
      .first<{ verdict: ReadinessFenceResult }>();
    if (!row || !['current', 'stale', 'forbidden', 'invalid-session', 'unavailable'].includes(row.verdict)) return 'unavailable';
    return row.verdict;
  } };
}
