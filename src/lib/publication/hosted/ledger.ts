import type { CaseId, ClientId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { OperationRecord, PublicationLedger, PublicationState, SignoffAcknowledgement, SignoffRecord } from './ports.ts';

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
  signed_at: string; state: 'recorded' | 'audited'; invalidated_at: string | null; invalidated_reason: string | null;
};
type OperationRow = {
  operation_id: string; request_sha256: string; client_id: string; case_id: string; kind: 'publish' | 'withdraw'; signoff_id: string | null; results_version: string;
  expected_kind: PublicationState['kind']; expected_version: string | null; actor_issuer: string; actor_subject: string; actor_kind: 'client' | 'staff';
  state: OperationRecord['state']; reason: string | null; at: string;
};

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const SIGNOFF_COLUMNS = ['signoff_id', 'operation_id', 'request_sha256', 'client_id', 'case_id', 'candidate_id', 'link_id', 'submission_revision_id', 'submission_manifest_sha256',
  'results_version', 'manifest_sha256', 'package_input_revision_id', 'diagnostics_sha256', 'validator_version', 'snapshot_revision', 'warning_fingerprints', 'acknowledgements',
  'signer_issuer', 'signer_subject', 'signer_kind', 'prepared_by_issuer', 'prepared_by_subject', 'self_approval', 'signed_at', 'state'] as const;
const OPERATION_COLUMNS = ['operation_id', 'request_sha256', 'client_id', 'case_id', 'kind', 'signoff_id', 'results_version', 'expected_kind', 'expected_version',
  'actor_issuer', 'actor_subject', 'actor_kind', 'state', 'reason', 'at'] as const;

function signoffOf(r: SignoffRow): SignoffRecord {
  return Object.freeze({
    signoffId: r.signoff_id, operationId: r.operation_id, requestSha256: r.request_sha256, clientId: r.client_id as ClientId, caseId: r.case_id as CaseId,
    candidateId: r.candidate_id, linkId: r.link_id, submissionRevisionId: r.submission_revision_id, submissionManifestSha256: r.submission_manifest_sha256,
    resultsVersion: r.results_version as ResultsVersion, manifestSha256: r.manifest_sha256, packageInputRevisionId: r.package_input_revision_id,
    diagnosticsSha256: r.diagnostics_sha256, validatorVersion: r.validator_version, snapshotRevision: r.snapshot_revision,
    warningFingerprints: Object.freeze(JSON.parse(r.warning_fingerprints) as string[]),
    acknowledgements: Object.freeze((JSON.parse(r.acknowledgements) as SignoffAcknowledgement[]).map((a) => Object.freeze(a))),
    signer: Object.freeze({ issuer: r.signer_issuer, subject: r.signer_subject, kind: r.signer_kind }),
    preparedBy: Object.freeze({ issuer: r.prepared_by_issuer, subject: r.prepared_by_subject }),
    selfApproval: r.self_approval === 1, signedAt: r.signed_at, state: r.state, invalidatedAt: r.invalidated_at, invalidatedReason: r.invalidated_reason,
  });
}
function signoffValues(s: SignoffRecord): PublicationD1Value[] {
  return [s.signoffId, s.operationId, s.requestSha256, s.clientId, s.caseId, s.candidateId, s.linkId, s.submissionRevisionId, s.submissionManifestSha256,
    s.resultsVersion, s.manifestSha256, s.packageInputRevisionId, s.diagnosticsSha256, s.validatorVersion, s.snapshotRevision,
    JSON.stringify([...s.warningFingerprints].sort()), JSON.stringify(s.acknowledgements.map((a) => ({ fingerprint: a.fingerprint, reason: a.reason }))),
    s.signer.issuer, s.signer.subject, s.signer.kind, s.preparedBy.issuer, s.preparedBy.subject, s.selfApproval ? 1 : 0, s.signedAt, 'recorded'];
}
function operationOf(r: OperationRow): OperationRecord {
  const expected: PublicationState = r.expected_kind === 'none' ? { kind: 'none' } : { kind: r.expected_kind, resultsVersion: r.expected_version as ResultsVersion };
  return Object.freeze({
    operationId: r.operation_id, requestSha256: r.request_sha256, clientId: r.client_id as ClientId, caseId: r.case_id as CaseId, kind: r.kind, signoffId: r.signoff_id,
    resultsVersion: r.results_version as ResultsVersion, expected: Object.freeze(expected), actor: Object.freeze({ issuer: r.actor_issuer, subject: r.actor_subject, kind: r.actor_kind }),
    state: r.state, reason: r.reason, at: r.at,
  });
}

/**
 * The D1 adapter of `PublicationLedger` over migration `0001_publication_ledger.sql`. Every read is scoped by client and
 * case; the migration's triggers refuse any rewrite, delete or REPLACE, so a lost race surfaces as a readback, never as
 * a silent overwrite. A storage fault rejects with `storage-unavailable`; it is never reported as success.
 */
export function d1PublicationLedger(db: PublicationD1): PublicationLedger {
  const bySignoffOperation = (operationId: string) =>
    db.prepare(`SELECT * FROM pub_signoff WHERE operation_id = ?`).bind(operationId).first<SignoffRow>().catch(unavailable);
  const byOperation = (operationId: string) =>
    db.prepare(`SELECT * FROM pub_operation WHERE operation_id = ?`).bind(operationId).first<OperationRow>().catch(unavailable);
  /** Runs one guarded update and confirms by readback that it took; a no-op update is a fault, not a success. */
  async function transition(sql: string, values: PublicationD1Value[], confirm: () => Promise<boolean>) {
    try { await db.prepare(sql).bind(...values).run(); } catch { /* a refused transition is judged by the readback below */ }
    if (!(await confirm())) unavailable();
  }

  async function signoff(a: { clientId: ClientId; caseId: CaseId; signoffId: string }) {
    const r = await db.prepare('SELECT * FROM pub_signoff WHERE client_id = ? AND case_id = ? AND signoff_id = ?').bind(a.clientId, a.caseId, a.signoffId).first<SignoffRow>().catch(unavailable);
    return r ? signoffOf(r) : null;
  }

  return {
    async recordSignoff(record) {
      const prior = await bySignoffOperation(record.operationId);
      if (prior) {
        if (prior.request_sha256 !== record.requestSha256 || prior.client_id !== record.clientId || prior.case_id !== record.caseId) return { kind: 'operation-reused' };
        return { kind: 'recorded', record: signoffOf(prior), repeated: true };
      }
      try {
        await db.prepare(`INSERT INTO pub_signoff (${SIGNOFF_COLUMNS.join(', ')}) VALUES (${SIGNOFF_COLUMNS.map(() => '?').join(', ')})`).bind(...signoffValues(record)).run();
      } catch {
        // a concurrent insert of the same operation, or a fault: the readback decides
        const raced = await bySignoffOperation(record.operationId);
        if (!raced) return unavailable();
        if (raced.request_sha256 !== record.requestSha256 || raced.client_id !== record.clientId || raced.case_id !== record.caseId) return { kind: 'operation-reused' };
        return { kind: 'recorded', record: signoffOf(raced), repeated: true };
      }
      const stored = await bySignoffOperation(record.operationId);
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
        e.kind, e.kind === 'none' ? null : e.resultsVersion, record.actor.issuer, record.actor.subject, record.actor.kind, 'pending', null, record.at];
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
        [a.state, a.reason, a.clientId, a.caseId, a.operationId], async () => (await byOperation(a.operationId))?.state === a.state);
    },
    async settleOperation(a) {
      await transition("UPDATE pub_operation SET state = 'audited' WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'applied'",
        [a.clientId, a.caseId, a.operationId], async () => (await byOperation(a.operationId))?.state === 'audited');
    },
  };
}
