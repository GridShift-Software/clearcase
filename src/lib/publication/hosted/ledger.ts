import type { AuditEvent, CaseId, ClientId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { OperationRecord, PublicationLedger, PublicationState, SignoffAcknowledgement, SignoffEvidence, SignoffIdentity, SignoffRecord } from './ports.ts';

/** The part of a Cloudflare D1 binding the ledger uses. The parent passes the client's per-deployment `DB`. */
export type PublicationD1Value = string | number | null;
export interface PublicationD1Statement {
  bind(...values: PublicationD1Value[]): PublicationD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface PublicationD1 { prepare(sql: string): PublicationD1Statement; batch(statements: PublicationD1Statement[]): Promise<unknown[]> }

type SignoffRow = {
  signoff_id: string; operation_id: string; request_sha256: string; client_id: string; case_id: string; candidate_id: string; link_id: string;
  submission_revision_id: string; submission_manifest_sha256: string; results_version: string; manifest_sha256: string; package_input_revision_id: string;
  diagnostics_sha256: string; validator_version: string; snapshot_revision: string; warning_fingerprints: string; acknowledgements: string;
  signer_issuer: string; signer_subject: string; signer_kind: 'client' | 'staff'; prepared_by_issuer: string; prepared_by_subject: string; self_approval: number;
  signed_at: string; audit_event: string; state: 'recorded' | 'audited'; invalidated_at: string | null; invalidated_reason: string | null;
  /** Present only when the ledger was composed with `evidence: true` (a left join of `pub_signoff_evidence`); all three are null for a v1 sign-off. */
  evidence_candidate_id?: string | null; evidence_generation?: string | null; evidence_root?: string | null;
};
type OperationRow = {
  operation_id: string; request_sha256: string; client_id: string; case_id: string; kind: 'publish' | 'withdraw'; signoff_id: string | null; results_version: string;
  expected_kind: PublicationState['kind']; expected_version: string | null; actor_issuer: string; actor_subject: string; actor_kind: 'client' | 'staff';
  signed_identity: string | null; audit_event: string; state: OperationRecord['state']; reason: string | null; at: string;
};

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const SIGNOFF_COLUMNS = ['signoff_id', 'operation_id', 'request_sha256', 'client_id', 'case_id', 'candidate_id', 'link_id', 'submission_revision_id', 'submission_manifest_sha256',
  'results_version', 'manifest_sha256', 'package_input_revision_id', 'diagnostics_sha256', 'validator_version', 'snapshot_revision', 'warning_fingerprints', 'acknowledgements',
  'signer_issuer', 'signer_subject', 'signer_kind', 'prepared_by_issuer', 'prepared_by_subject', 'self_approval', 'signed_at', 'audit_event', 'state'] as const;
const OPERATION_COLUMNS = ['operation_id', 'request_sha256', 'client_id', 'case_id', 'kind', 'signoff_id', 'results_version', 'expected_kind', 'expected_version',
  'actor_issuer', 'actor_subject', 'actor_kind', 'signed_identity', 'audit_event', 'state', 'reason', 'at'] as const;

/**
 * A v1 acknowledgement list is stored as it always was. A v2 list is stored once per group, as `{format, groups: [{code, reason,
 * fingerprints}]}`, so a reason is written once however many warnings share it (D1 caps one value at 2 MB). Reading expands a group back
 * to one acknowledgement per fingerprint, which is what the rest of the code compares.
 */
const GROUPED = 'clearcase.signoff-acknowledgements/2';
export const MAX_SIGNOFF_VALUE_BYTES = 1024 * 1024;
const byFingerprint = (a: { fingerprint: string }, b: { fingerprint: string }) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
function acknowledgementsJson(acks: readonly SignoffAcknowledgement[]): string {
  if (!acks.some((a) => a.code !== undefined)) return JSON.stringify(acks.map((a) => ({ fingerprint: a.fingerprint, reason: a.reason })));
  if (acks.some((a) => a.code === undefined)) return unavailable();
  const groups = new Map<string, { code: string; reason: string; fingerprints: string[] }>();
  for (const a of [...acks].sort(byFingerprint)) {
    const key = JSON.stringify([a.code, a.reason]);
    (groups.get(key) ?? groups.set(key, { code: a.code!, reason: a.reason, fingerprints: [] }).get(key)!).fingerprints.push(a.fingerprint);
  }
  return JSON.stringify({ format: GROUPED, groups: [...groups.values()].sort((x, y) => (x.code + x.reason < y.code + y.reason ? -1 : 1)) });
}
function acknowledgementsOf(text: string): readonly SignoffAcknowledgement[] {
  const v = JSON.parse(text) as unknown;
  if (Array.isArray(v)) return Object.freeze((v as SignoffAcknowledgement[]).map((a) => Object.freeze(a)));
  const grouped = v as { format?: unknown; groups?: { code: string; reason: string; fingerprints: string[] }[] };
  if (grouped?.format !== GROUPED || !Array.isArray(grouped.groups)) return unavailable();
  return Object.freeze(grouped.groups.flatMap((g) => g.fingerprints.map((fingerprint) => ({ fingerprint, reason: g.reason, code: g.code }))).sort(byFingerprint).map((a) => Object.freeze(a)));
}
const canonicalEvidence = (e: SignoffEvidence | null) => (e ? JSON.stringify([e.candidateId, e.generation, e.root]) : null);
const evidenceOf = (r: SignoffRow): SignoffEvidence | null =>
  r.evidence_root == null ? null : Object.freeze({ candidateId: r.evidence_candidate_id as string, generation: r.evidence_generation as string, root: r.evidence_root });

function signoffOf(r: SignoffRow): SignoffRecord {
  const evidence = evidenceOf(r);
  return Object.freeze({
    signoffId: r.signoff_id, operationId: r.operation_id, requestSha256: r.request_sha256, clientId: r.client_id as ClientId, caseId: r.case_id as CaseId,
    candidateId: r.candidate_id, linkId: r.link_id, submissionRevisionId: r.submission_revision_id, submissionManifestSha256: r.submission_manifest_sha256,
    resultsVersion: r.results_version as ResultsVersion, manifestSha256: r.manifest_sha256, packageInputRevisionId: r.package_input_revision_id,
    diagnosticsSha256: r.diagnostics_sha256, validatorVersion: r.validator_version, snapshotRevision: r.snapshot_revision,
    warningFingerprints: Object.freeze(JSON.parse(r.warning_fingerprints) as string[]),
    acknowledgements: acknowledgementsOf(r.acknowledgements),
    signer: Object.freeze({ issuer: r.signer_issuer, subject: r.signer_subject, kind: r.signer_kind }),
    preparedBy: Object.freeze({ issuer: r.prepared_by_issuer, subject: r.prepared_by_subject }),
    selfApproval: r.self_approval === 1, signedAt: r.signed_at, auditEvent: JSON.parse(r.audit_event) as AuditEvent, state: r.state, invalidatedAt: r.invalidated_at, invalidatedReason: r.invalidated_reason,
    ...(evidence ? { evidence } : {}),
  });
}
function signoffValues(s: SignoffRecord): PublicationD1Value[] {
  return [s.signoffId, s.operationId, s.requestSha256, s.clientId, s.caseId, s.candidateId, s.linkId, s.submissionRevisionId, s.submissionManifestSha256,
    s.resultsVersion, s.manifestSha256, s.packageInputRevisionId, s.diagnosticsSha256, s.validatorVersion, s.snapshotRevision,
    JSON.stringify([...s.warningFingerprints].sort()), acknowledgementsJson(s.acknowledgements),
    s.signer.issuer, s.signer.subject, s.signer.kind, s.preparedBy.issuer, s.preparedBy.subject, s.selfApproval ? 1 : 0, s.signedAt, JSON.stringify(s.auditEvent), 'recorded'];
}
function operationOf(r: OperationRow): OperationRecord {
  const expected: PublicationState = r.expected_kind === 'none' ? { kind: 'none' } : { kind: r.expected_kind, resultsVersion: r.expected_version as ResultsVersion };
  return Object.freeze({
    operationId: r.operation_id, requestSha256: r.request_sha256, clientId: r.client_id as ClientId, caseId: r.case_id as CaseId, kind: r.kind, signoffId: r.signoff_id,
    resultsVersion: r.results_version as ResultsVersion, expected: Object.freeze(expected), actor: Object.freeze({ issuer: r.actor_issuer, subject: r.actor_subject, kind: r.actor_kind }),
    signedIdentity: r.signed_identity === null ? null : JSON.parse(r.signed_identity) as SignoffIdentity,
    auditEvent: JSON.parse(r.audit_event) as AuditEvent, state: r.state, reason: r.reason, at: r.at,
  });
}

/**
 * The D1 adapter of `PublicationLedger` over migration `0001_publication_ledger.sql`. Every read is scoped by client and
 * case; the migration's triggers refuse any rewrite, delete or REPLACE, so a lost race surfaces as a readback, never as
 * a silent overwrite. A storage fault rejects with `storage-unavailable`; it is never reported as success.
 */
export interface PublicationLedgerOptions {
  /**
   * The deployment has migration 0005 (`pub_signoff_evidence`). Off, every statement is exactly what it was before snapshot v2, no
   * statement names the evidence table, and a sign-off that carries evidence is refused. On, a v2 sign-off is written with its
   * evidence row in one batch, and every read reports the evidence row beside the sign-off.
   */
  readonly evidence?: boolean;
}
const EVIDENCE_SELECT = `SELECT s.*, e.candidate_id AS evidence_candidate_id, e.generation AS evidence_generation, e.evidence_root AS evidence_root
  FROM pub_signoff s LEFT JOIN pub_signoff_evidence e ON e.signoff_id = s.signoff_id`;

export function d1PublicationLedger(db: PublicationD1, options: PublicationLedgerOptions = {}): PublicationLedger {
  const withEvidence = options.evidence === true;
  const bySignoffOperation = (operationId: string) =>
    db.prepare(withEvidence ? `${EVIDENCE_SELECT} WHERE s.operation_id = ?` : `SELECT * FROM pub_signoff WHERE operation_id = ?`).bind(operationId).first<SignoffRow>().catch(unavailable);
  const byOperation = (operationId: string) =>
    db.prepare(`SELECT * FROM pub_operation WHERE operation_id = ?`).bind(operationId).first<OperationRow>().catch(unavailable);
  /** Runs one guarded update and confirms by readback that it took; a no-op update is a fault, not a success. */
  async function transition(sql: string, values: PublicationD1Value[], confirm: () => Promise<boolean>) {
    try { await db.prepare(sql).bind(...values).run(); } catch { /* a refused transition is judged by the readback below */ }
    if (!(await confirm())) unavailable();
  }

  async function signoff(a: { clientId: ClientId; caseId: CaseId; signoffId: string }) {
    const r = await db.prepare(withEvidence ? `${EVIDENCE_SELECT} WHERE s.client_id = ? AND s.case_id = ? AND s.signoff_id = ?` : 'SELECT * FROM pub_signoff WHERE client_id = ? AND case_id = ? AND signoff_id = ?')
      .bind(a.clientId, a.caseId, a.signoffId).first<SignoffRow>().catch(unavailable);
    return r ? signoffOf(r) : null;
  }

  return {
    async recordSignoff(record) {
      const prior = await bySignoffOperation(record.operationId);
      if (prior) {
        if (prior.request_sha256 !== record.requestSha256 || prior.client_id !== record.clientId || prior.case_id !== record.caseId) return { kind: 'operation-reused' };
        return { kind: 'recorded', record: signoffOf(prior), repeated: true };
      }
      const evidence = record.evidence;
      // Evidence is a v2 matter: a ledger not composed for it, or a record that names another candidate than its own, writes nothing.
      if (evidence && (!withEvidence || evidence.candidateId !== record.candidateId)) return unavailable();
      const values = signoffValues(record);
      if (evidence && (values[15]!.toString().length > MAX_SIGNOFF_VALUE_BYTES || values[16]!.toString().length > MAX_SIGNOFF_VALUE_BYTES)) return unavailable();
      try {
        const insert = db.prepare(`INSERT INTO pub_signoff (${SIGNOFF_COLUMNS.join(', ')}) VALUES (${SIGNOFF_COLUMNS.map(() => '?').join(', ')})`).bind(...values);
        if (!evidence) await insert.run();
        // The sign-off first: the evidence row references it. The candidate comes from the sign-off row itself, so the two cannot differ.
        else await db.batch([insert, db.prepare(`INSERT INTO pub_signoff_evidence (signoff_id, candidate_id, generation, evidence_root)
          SELECT signoff_id, candidate_id, ?, ? FROM pub_signoff WHERE signoff_id = ?`).bind(evidence.generation, evidence.root, record.signoffId)]);
      } catch {
        // a concurrent insert of the same operation, or a fault: the readback decides
        const raced = await bySignoffOperation(record.operationId);
        if (!raced) return unavailable();
        if (raced.request_sha256 !== record.requestSha256 || raced.client_id !== record.clientId || raced.case_id !== record.caseId) return { kind: 'operation-reused' };
        return { kind: 'recorded', record: signoffOf(raced), repeated: true };
      }
      const stored = await bySignoffOperation(record.operationId);
      if (stored && record.evidence && canonicalEvidence(evidenceOf(stored)) !== canonicalEvidence(record.evidence)) return unavailable();
      return stored ? { kind: 'recorded', record: signoffOf(stored), repeated: false } : unavailable();
    },
    signoff,
    async settleSignoff(a) {
      await transition("UPDATE pub_signoff SET state = 'audited' WHERE client_id = ? AND case_id = ? AND signoff_id = ? AND state = 'recorded'", [a.clientId, a.caseId, a.signoffId],
        async () => (await signoff(a))?.state === 'audited');
    },
    async invalidateSignoff(a) {
      await transition('UPDATE pub_signoff SET invalidated_at = ?, invalidated_reason = ? WHERE client_id = ? AND case_id = ? AND signoff_id = ? AND invalidated_at IS NULL',
        [a.at, a.reason, a.clientId, a.caseId, a.signoffId], async () => (await signoff(a))?.invalidatedAt != null);
    },
    async operation(a) {
      const r = await db.prepare('SELECT * FROM pub_operation WHERE client_id = ? AND case_id = ? AND operation_id = ?').bind(a.clientId, a.caseId, a.operationId).first<OperationRow>().catch(unavailable);
      return r ? operationOf(r) : null;
    },
    async beginOperation(record) {
      const same = (r: OperationRow) => r.request_sha256 === record.requestSha256 && r.client_id === record.clientId && r.case_id === record.caseId && r.kind === record.kind;
      const prior = await byOperation(record.operationId);
      if (prior) return same(prior) ? { kind: 'begun', record: operationOf(prior), repeated: true } : { kind: 'operation-reused' };
      const e = record.expected, values: PublicationD1Value[] = [record.operationId, record.requestSha256, record.clientId, record.caseId, record.kind, record.signoffId, record.resultsVersion,
        e.kind, e.kind === 'none' ? null : e.resultsVersion, record.actor.issuer, record.actor.subject, record.actor.kind, record.signedIdentity === null ? null : JSON.stringify(record.signedIdentity), JSON.stringify(record.auditEvent), 'pending', null, record.at];
      try {
        await db.prepare(`INSERT INTO pub_operation (${OPERATION_COLUMNS.join(', ')}) VALUES (${OPERATION_COLUMNS.map(() => '?').join(', ')})`).bind(...values).run();
      } catch {
        const raced = await byOperation(record.operationId);
        if (!raced) return unavailable();
        return same(raced) ? { kind: 'begun', record: operationOf(raced), repeated: true } : { kind: 'operation-reused' };
      }
      const stored = await byOperation(record.operationId);
      return stored ? { kind: 'begun', record: operationOf(stored), repeated: false } : unavailable();
    },
    async finishOperation(a) {
      await transition("UPDATE pub_operation SET state = ?, reason = ? WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state IN ('pending', 'failed')",
        [a.state, a.reason, a.clientId, a.caseId, a.operationId], async () => {
          const current = await byOperation(a.operationId);
          // A concurrent receipt recovery may already have settled this same applied operation. Never move it back.
          return current?.state === a.state || (a.state === 'applied' && current?.state === 'audited');
        });
    },
    async settleOperation(a) {
      await transition("UPDATE pub_operation SET state = 'audited' WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'applied'",
        [a.clientId, a.caseId, a.operationId], async () => (await byOperation(a.operationId))?.state === 'audited');
    },
  };
}
