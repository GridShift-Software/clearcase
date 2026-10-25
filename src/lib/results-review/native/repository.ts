import type { AuditEvent } from '../../server/runtime/contracts.ts';
import { verifyCandidateAudit } from './audit.ts';
import { canonicalJson } from '../../case-package/canonical.ts';
import { parseStrictJson } from '../../case-package/strict-json.ts';
import { freeze } from '../../server/runtime/data.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { CandidateImportLink, ImportLinkCoverage } from '../../server/runtime/hosted/alpha-contracts.ts';
import { id, resultsVersion as brandVersion, sha256 as brandSha } from '../../server/runtime/ids.ts';
import { sha256Text } from './digest.ts';
import type { ChangeFact, CommittedCandidateAudit, CorrectionRecord, LinkedCandidate, NativeCandidateRepository, NativeD1, Origin, Scoped } from './ports.ts';

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const integrity = (): never => { throw contractError('integrity', false); };

type Row = {
  candidate_id: string; origin: Origin; parent_candidate_id: string | null; operation_id: string; cand_results_version: string; cand_manifest_sha256: string; cand_input_revision_id: string;
  link_id: string; submission_revision_id: string; submission_manifest_sha256: string; results_version: string; manifest_sha256: string; input_revision_id: string;
  coverage_json: string; operator_issuer: string; operator_subject: string; linked_at: string; link_sha256: string; superseded_by: string | null; audit_settled: number; event_id: string | null; event_json: string | null; event_sha256: string | null;
};
const SELECT = `SELECT c.candidate_id, c.origin, c.parent_candidate_id, c.operation_id, c.results_version AS cand_results_version, c.manifest_sha256 AS cand_manifest_sha256, c.input_revision_id AS cand_input_revision_id,
  l.link_id, l.submission_revision_id, l.submission_manifest_sha256, l.results_version, l.manifest_sha256, l.input_revision_id, l.coverage_json, l.operator_issuer, l.operator_subject, l.linked_at, l.link_sha256,
  s.new_candidate_id AS superseded_by, ai.event_id, ai.event_json, ai.event_sha256,
  EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
    ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
    WHERE ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id) AS audit_settled
  FROM native_candidate c
  JOIN native_import_link l ON l.client_id = c.client_id AND l.case_id = c.case_id AND l.candidate_id = c.candidate_id
  LEFT JOIN native_candidate_audit_intent ai ON ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id
  LEFT JOIN native_candidate_supersession s ON s.client_id = c.client_id AND s.case_id = c.case_id AND s.old_candidate_id = c.candidate_id`;

/** The link as a plain value: the exact shape that is hashed when it is written and again when it is read. */
function linkOf(s: Scoped, r: { link_id: string; submission_revision_id: string; submission_manifest_sha256: string; candidate_id: string; results_version: string; manifest_sha256: string; input_revision_id: string; operator_issuer: string; operator_subject: string; linked_at: string }, coverage: ImportLinkCoverage): CandidateImportLink {
  return {
    format: 'clearcase.candidate-import-link/1', linkId: r.link_id, clientId: s.clientId, caseId: s.caseId,
    submissionRevisionId: r.submission_revision_id, submissionManifestSha256: brandSha(r.submission_manifest_sha256),
    candidate: { clientId: s.clientId, caseId: s.caseId, candidateId: r.candidate_id, resultsVersion: brandVersion(r.results_version), manifestSha256: brandSha(r.manifest_sha256), packageInputRevisionId: id('input-revision', r.input_revision_id) },
    coverage,
    operator: { issuer: r.operator_issuer, subject: r.operator_subject, kind: 'staff' },
    linkedAt: r.linked_at, attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked',
  };
}
export const linkDigest = (link: CandidateImportLink): Promise<string> => sha256Text(canonicalJson(link));

/** The D1 adapter over the native candidate and audit-intent migrations. */
export function d1NativeCandidateRepository(db: NativeD1): NativeCandidateRepository {
  type Attempt = { kind: Origin; operator_issuer: string; operator_subject: string; request_sha256: string; submission_revision_id: string; base_candidate_id: string | null; declared_at: string };
  const attempt = (s: Scoped, operationId: string) =>
    db.prepare('SELECT kind, operator_issuer, operator_subject, request_sha256, submission_revision_id, base_candidate_id, declared_at FROM native_import_attempt WHERE client_id = ? AND case_id = ? AND operation_id = ?')
      .bind(s.clientId, s.caseId, operationId).first<Attempt>().catch(unavailable);

  async function hydrate(s: Scoped, r: Row): Promise<LinkedCandidate> {
    // The candidate row and the link row must agree on what they pin, and the link must equal what was hashed at write time.
    if (r.cand_results_version !== r.results_version || r.cand_manifest_sha256 !== r.manifest_sha256 || r.cand_input_revision_id !== r.input_revision_id) return integrity();
    let coverage: ImportLinkCoverage;
    try { coverage = parseStrictJson(r.coverage_json) as unknown as ImportLinkCoverage; } catch { return integrity(); }
    const link = linkOf(s, r, coverage);
    try { if ((await linkDigest(link)) !== r.link_sha256) return integrity(); } catch { return integrity(); }
    if (r.event_json !== null) {
      if (await sha256Text(r.event_json) !== r.event_sha256) return integrity();
      let event: AuditEvent;
      try { event = parseStrictJson(r.event_json) as unknown as AuditEvent; } catch { return integrity(); }
      if (event?.eventId !== r.event_id || canonicalJson(event) !== r.event_json) return integrity();
      await verifyCandidateAudit({ candidateId: r.candidate_id, origin: r.origin, link }, event);
    }
    let correction: CorrectionRecord | null = null;
    if (r.origin === 'correction') {
      const sup = await db.prepare('SELECT reason, operator_issuer, operator_subject, at FROM native_candidate_supersession WHERE client_id = ? AND case_id = ? AND new_candidate_id = ?')
        .bind(s.clientId, s.caseId, r.candidate_id).first<{ reason: string; operator_issuer: string; operator_subject: string; at: string }>().catch(unavailable);
      const changes = await db.prepare('SELECT path, before_sha256, before_size, after_sha256, after_size FROM native_correction_change WHERE client_id = ? AND case_id = ? AND candidate_id = ? ORDER BY path')
        .bind(s.clientId, s.caseId, r.candidate_id).all<{ path: string; before_sha256: string | null; before_size: number | null; after_sha256: string; after_size: number }>().catch(unavailable);
      if (!sup || changes.results.length === 0) return integrity();
      correction = { reason: sup.reason, operator: { issuer: sup.operator_issuer, subject: sup.operator_subject }, at: sup.at,
        changes: changes.results.map((c): ChangeFact => ({ path: c.path, before: c.before_sha256 === null ? null : { sha256: c.before_sha256, size: c.before_size! }, after: { sha256: c.after_sha256, size: c.after_size } })) };
    }
    return freeze(JSON.parse(JSON.stringify({ candidateId: r.candidate_id, origin: r.origin, parentCandidateId: r.parent_candidate_id, current: r.superseded_by === null && r.audit_settled === 1, supersededBy: r.superseded_by, link, correction })) as LinkedCandidate);
  }
  const one = async (s: Scoped, where: string, value: string) => {
    const r = await db.prepare(`${SELECT} WHERE c.client_id = ? AND c.case_id = ? AND ${where} = ?`).bind(s.clientId, s.caseId, value).first<Row>().catch(unavailable);
    return r ? hydrate(s, r) : null;
  };

  async function auditIntent(a: Scoped & { candidateId: string }): Promise<CommittedCandidateAudit> {
    const row = await db.prepare('SELECT event_id, event_json, event_sha256 FROM native_candidate_audit_intent WHERE client_id = ? AND case_id = ? AND candidate_id = ?')
      .bind(a.clientId, a.caseId, a.candidateId).first<{ event_id: string; event_json: string; event_sha256: string }>().catch(unavailable);
    const c = await one(a, 'c.candidate_id', a.candidateId);
    if (!row || !c || await sha256Text(row.event_json) !== row.event_sha256) return integrity();
    let event: AuditEvent;
    try { event = parseStrictJson(row.event_json) as unknown as AuditEvent; } catch { return integrity(); }
    if (event?.eventId !== row.event_id || canonicalJson(event) !== row.event_json) return integrity();
    await verifyCandidateAudit(c, event);
    return freeze({ clientId: a.clientId, caseId: a.caseId, candidateId: a.candidateId, event });
  }

  return {
    async claim(a) {
      const same = (p: Attempt) => p.kind === a.kind && p.operator_issuer === a.operator.issuer && p.operator_subject === a.operator.subject && p.request_sha256 === a.requestSha256
        && p.submission_revision_id === a.submissionRevisionId && p.base_candidate_id === a.baseCandidateId;
      const prior = await attempt(a, a.operationId);
      if (prior) return same(prior) ? { kind: 'repeated', at: prior.declared_at } : { kind: 'operation-reused' };
      // INSERT ... WHERE NOT EXISTS: a concurrent claim of the same operation inserts nothing here (and the migration's BEFORE
      // INSERT trigger refuses a colliding insert, even one with ON CONFLICT).
      await db.prepare(`INSERT INTO native_import_attempt (client_id, case_id, operation_id, kind, operator_issuer, operator_subject, request_sha256, submission_revision_id, base_candidate_id, declared_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_import_attempt WHERE client_id = ? AND case_id = ? AND operation_id = ?)`)
        .bind(a.clientId, a.caseId, a.operationId, a.kind, a.operator.issuer, a.operator.subject, a.requestSha256, a.submissionRevisionId, a.baseCandidateId, a.at, a.clientId, a.caseId, a.operationId).run().catch(unavailable);
      const row = await attempt(a, a.operationId);
      if (!row) return unavailable();
      return same(row) ? { kind: 'claimed', at: row.declared_at } : { kind: 'operation-reused' };
    },
    byOperation: (a) => one(a, 'c.operation_id', a.operationId),
    async byResultsVersion(a) {
      const r = await db.prepare('SELECT candidate_id, manifest_sha256 FROM native_candidate WHERE client_id = ? AND case_id = ? AND results_version = ?')
        .bind(a.clientId, a.caseId, a.resultsVersion).first<{ candidate_id: string; manifest_sha256: string }>().catch(unavailable);
      return r ? { candidateId: r.candidate_id, manifestSha256: r.manifest_sha256 } : null;
    },
    async record(a) {
      const l = a.link, digest = await linkDigest(l);
      await verifyCandidateAudit({ origin: a.origin, candidateId: l.candidate.candidateId, link: l }, a.auditEvent);
      const eventJson = canonicalJson(a.auditEvent), eventSha = await sha256Text(eventJson);
      const s: Scoped = { clientId: a.clientId, caseId: a.caseId };
      const statements = [
        db.prepare('INSERT INTO native_candidate (client_id, case_id, candidate_id, results_version, manifest_sha256, input_revision_id, origin, parent_candidate_id, operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.clientId, s.caseId, l.candidate.candidateId, l.candidate.resultsVersion, l.candidate.manifestSha256, l.candidate.packageInputRevisionId, a.origin, a.parentCandidateId, a.operationId, l.linkedAt),
        db.prepare('INSERT INTO native_import_link (client_id, case_id, link_id, candidate_id, submission_revision_id, submission_manifest_sha256, results_version, manifest_sha256, input_revision_id, coverage_json, operator_issuer, operator_subject, linked_at, link_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.clientId, s.caseId, l.linkId, l.candidate.candidateId, l.submissionRevisionId, l.submissionManifestSha256, l.candidate.resultsVersion, l.candidate.manifestSha256, l.candidate.packageInputRevisionId, canonicalJson(l.coverage), l.operator.issuer, l.operator.subject, l.linkedAt, digest),
      ];
      if (a.correction && a.parentCandidateId) {
        const c = a.correction;
        statements.push(db.prepare('INSERT INTO native_candidate_supersession (client_id, case_id, old_candidate_id, new_candidate_id, reason, operator_issuer, operator_subject, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.clientId, s.caseId, a.parentCandidateId, l.candidate.candidateId, c.reason, c.operator.issuer, c.operator.subject, c.at));
        for (const ch of c.changes) statements.push(db.prepare('INSERT INTO native_correction_change (client_id, case_id, candidate_id, path, before_sha256, before_size, after_sha256, after_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.clientId, s.caseId, l.candidate.candidateId, ch.path, ch.before?.sha256 ?? null, ch.before?.size ?? null, ch.after.sha256, ch.after.size));
      }
      statements.push(db.prepare('INSERT INTO native_candidate_audit_intent (client_id, case_id, candidate_id, event_id, event_json, event_sha256) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(s.clientId, s.caseId, l.candidate.candidateId, a.auditEvent.eventId, eventJson, eventSha));
      try { await db.batch(statements); } catch { /* the outcome is unknown from here (a lost answer can follow a commit): read again below */ }
      const now = await one(s, 'c.operation_id', a.operationId);
      // Only a recorded link equal to the one this call wrote is success; anything else is a fault, never a pass.
      if (!now || (await linkDigest(now.link)) !== digest) return unavailable();
      const intent = await auditIntent({ ...s, candidateId: now.candidateId });
      if (canonicalJson(intent.event) !== eventJson) return integrity();
      return now;
    },
    auditIntent,
    async pendingAudits(a) {
      if (!Number.isSafeInteger(a.limit) || a.limit < 1 || a.limit > 100) throw new TypeError('audit recovery limit must be 1..100');
      const rows = await db.prepare(`SELECT i.candidate_id FROM native_candidate_audit_intent i WHERE i.client_id = ? AND i.case_id = ?
        AND NOT EXISTS (SELECT 1 FROM native_candidate_audit_settlement s WHERE s.client_id = i.client_id AND s.case_id = i.case_id AND s.candidate_id = i.candidate_id)
        ORDER BY i.candidate_id LIMIT ?`).bind(a.clientId, a.caseId, a.limit).all<{ candidate_id: string }>().catch(unavailable);
      const intents: CommittedCandidateAudit[] = [];
      for (const r of rows.results) intents.push(await auditIntent({ ...a, candidateId: r.candidate_id }));
      return intents;
    },
    async settleAudit(a) {
      const intent = await auditIntent(a);
      if (canonicalJson(intent.event) !== canonicalJson(a.event)) return integrity();
      await db.prepare(`INSERT INTO native_candidate_audit_settlement (client_id, case_id, candidate_id, event_id)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_candidate_audit_settlement WHERE client_id = ? AND case_id = ? AND candidate_id = ?)`)
        .bind(a.clientId, a.caseId, a.candidateId, a.event.eventId, a.clientId, a.caseId, a.candidateId).run().catch(() => undefined);
      const row = await db.prepare('SELECT event_id FROM native_candidate_audit_settlement WHERE client_id = ? AND case_id = ? AND candidate_id = ?')
        .bind(a.clientId, a.caseId, a.candidateId).first<{ event_id: string }>().catch(unavailable);
      if (row?.event_id !== a.event.eventId) return unavailable();
    },
    candidate: (a) => one(a, 'c.candidate_id', a.candidateId),
    async list(a) {
      const rows = await db.prepare(`${SELECT} WHERE c.client_id = ? AND c.case_id = ? ORDER BY l.linked_at, c.candidate_id`).bind(a.clientId, a.caseId).all<Row>().catch(unavailable);
      const out: LinkedCandidate[] = [];
      for (const r of rows.results) out.push(await hydrate(a, r));
      return out;
    },
  };
}
