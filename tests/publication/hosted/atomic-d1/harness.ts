import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { id, resultsVersion, sha256 } from '../../../../src/lib/server/runtime/ids.ts';
import type { AuditEvent, CaseId, ClientId, Identity, Principal, ResultsVersion, SessionId } from '../../../../src/lib/server/runtime/contracts.ts';
import { d1PublicationLedger } from '../../../../src/lib/publication/hosted/ledger.ts';
import { d1PublicationPublisher, d1PublicationSnapshotRevision } from '../../../../src/lib/publication/hosted/d1-publisher.ts';
import type { AtomicPublicationMutation, CandidateSnapshot, NativePublicationPorts, OperationRecord, PublicationIntent, PublicationState, SignoffIdentity, SignoffRecord } from '../../../../src/lib/publication/hosted/ports.ts';
import { FileD1 } from './sqlite.ts';

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE = id('case', 'case-a') as CaseId;
export const OTHER_CASE = id('case', 'case-b') as CaseId;
export const NOW = '2026-10-25T07:00:00.000Z';
export const PRINCIPAL: Principal = { issuer: 'https://issuer.test', subject: 'publisher-1', kind: 'staff' };
export const SESSION = id('session', 'sess-publisher-0001') as SessionId;
export const hash = (n: string) => n.repeat(64);
export const version = (n: string) => resultsVersion(`sha256:${hash(n)}`);
export const error = (code: string) => Object.assign(new Error(code), { code });
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export function insert(db: FileD1, table: string, row: Record<string, string | number | null>) {
  const keys = Object.keys(row);
  db.exec(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}
export function event(operationId: string, rv: ResultsVersion, sessionId = SESSION): AuditEvent {
  return { eventId: `publication-${operationId}`, actor: { kind: 'verified', principal: PRINCIPAL, sessionId }, action: 'publication.publish', object: { kind: 'publication', id: operationId, caseId: CASE }, version: rv, outcome: 'succeeded', at: NOW };
}

export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'clearcase-atomic-d1-'));
  readonly path = join(this.dir, 'publication.sqlite');
  readonly db = new FileD1(this.path, true);
  readonly editor = new FileD1(this.path);
  readonly ledger = d1PublicationLedger(this.db);
  readonly checks: AtomicPublicationMutation['authority'][] = [];
  sessionError: unknown = null;
  sessionHook: (() => void | Promise<void>) | null = null;
  readonly publisher = this.makePublisher();
  readonly events: AuditEvent[] = [];
  constructor() {
    insert(this.db, 'rs_storage_identity', { singleton: 1, client_id: CLIENT, layout: 'clearcase.rs/1' });
    insert(this.db, 'rs_case', { case_id: CASE }); insert(this.db, 'rs_case', { case_id: OTHER_CASE });
    this.grant();
  }
  makePublisher(db = this.db) {
    return d1PublicationPublisher({ db, clientId: CLIENT, checkSession: async (authority) => {
      this.checks.push(structuredClone(authority));
      if (this.sessionError) throw this.sessionError;
      await this.sessionHook?.();
    } });
  }
  grant(principal = PRINCIPAL, role = 'publisher', caseId = CASE, grantId = 'grant-publisher-1') {
    insert(this.db, 'tenant_case_grants', { grant_id: grantId, client_id: CLIENT, scope: 'case', case_id: caseId,
      issuer: principal.issuer, subject: principal.subject, principal_kind: principal.kind, role, slot: role,
      state: 'active', expires_at: null, version: 1, created_operation_id: `create-${grantId}`, request: '{}',
      created_by_issuer: principal.issuer, created_by_subject: principal.subject, created_at: NOW, supersedes: null, revoked_operation_id: null, revoked_at: null });
  }
  revoke() { this.editor.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ?, revoked_operation_id = 'revoke-1', version = version + 1 WHERE grant_id = 'grant-publisher-1'", NOW); }
  candidate(n = '1', parent: string | null = null, auditSettled = true) {
    const candidateId = `candidate-${n}`, operationId = `import-operation-${n}`, rv = version(n), manifest = hash(n);
    insert(this.db, 'rs_results_version', { version_id: rv, case_id: CASE, state: 'stored', attempt: 1, operation_id: operationId,
      manifest_sha256: manifest, input_revision_id: 'input-1', case_label: 'Synthetic case', created: NOW, verdict: 'accept', validator_version: 'validator-1',
      diagnostics_sha256: hash('d'), warning_fingerprints: '[]', expected_documents: 0, expected_assets: 0, expected_seeds: 0, expected_files: 0,
      read_model_sha256: hash('e'), overview: '{}', package_bytes: 0, keep: 0, staged_at: NOW, stored_at: NOW, import_seq: Number(n) });
    insert(this.db, 'native_import_attempt', { client_id: CLIENT, case_id: CASE, operation_id: operationId, kind: parent ? 'correction' : 'import',
      operator_issuer: PRINCIPAL.issuer, operator_subject: 'preparer', request_sha256: hash('f'), submission_revision_id: 'submission-1', base_candidate_id: parent, declared_at: NOW });
    insert(this.db, 'native_candidate', { client_id: CLIENT, case_id: CASE, candidate_id: candidateId, results_version: rv,
      manifest_sha256: manifest, input_revision_id: 'input-1', origin: parent ? 'correction' : 'import', parent_candidate_id: parent, operation_id: operationId, created_at: NOW });
    const link = { format: 'clearcase.candidate-import-link/1', linkId: `link-${n}`, clientId: CLIENT, caseId: CASE,
      submissionRevisionId: 'submission-1', submissionManifestSha256: hash('a'),
      candidate: { clientId: CLIENT, caseId: CASE, candidateId, resultsVersion: rv, manifestSha256: manifest, packageInputRevisionId: 'input-1' },
      coverage: { kind: 'synthetic' }, operator: { issuer: PRINCIPAL.issuer, subject: 'preparer', kind: 'staff' }, linkedAt: NOW,
      attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' };
    insert(this.db, 'native_import_link', { client_id: CLIENT, case_id: CASE, link_id: link.linkId, candidate_id: candidateId,
      submission_revision_id: link.submissionRevisionId, submission_manifest_sha256: link.submissionManifestSha256, results_version: rv,
      manifest_sha256: manifest, input_revision_id: 'input-1', coverage_json: JSON.stringify(link.coverage), operator_issuer: PRINCIPAL.issuer,
      operator_subject: 'preparer', linked_at: NOW, link_sha256: createHash('sha256').update(canonical(link)).digest('hex') });
    const audit = { ...event(`candidate-import-${n}`, rv), action: 'results.import' }, eventJson = canonical(audit);
    insert(this.db, 'native_candidate_audit_intent', { client_id: CLIENT, case_id: CASE, candidate_id: candidateId, event_id: audit.eventId,
      event_json: eventJson, event_sha256: createHash('sha256').update(eventJson).digest('hex') });
    if (auditSettled) insert(this.db, 'native_candidate_audit_settlement', { client_id: CLIENT, case_id: CASE, candidate_id: candidateId, event_id: audit.eventId });
    return candidateId;
  }
  supersede(oldCandidateId: string, newCandidateId: string) {
    insert(this.editor, 'native_candidate_supersession', { client_id: CLIENT, case_id: CASE, old_candidate_id: oldCandidateId, new_candidate_id: newCandidateId,
      reason: 'Synthetic correction', operator_issuer: PRINCIPAL.issuer, operator_subject: 'preparer', at: NOW });
  }
  async signed(candidateId = this.candidate(), operationId = 'signoff-operation-0001', audited = true, forcedRevision?: string) {
    const c = this.db.rows<{ results_version: ResultsVersion; manifest_sha256: string; link_id: string }>(`SELECT c.results_version, c.manifest_sha256, l.link_id FROM native_candidate c
      JOIN native_import_link l USING(client_id, case_id, candidate_id) WHERE c.candidate_id = ?`, candidateId)[0];
    const identity: SignoffIdentity = { candidateId, linkId: c.link_id, submissionRevisionId: 'submission-1', submissionManifestSha256: hash('a'),
      resultsVersion: c.results_version, manifestSha256: c.manifest_sha256, packageInputRevisionId: 'input-1', diagnosticsSha256: hash('d'),
      validatorVersion: 'validator-1', snapshotRevision: forcedRevision ?? (await d1PublicationSnapshotRevision(this.db, { clientId: CLIENT, caseId: CASE, candidateId }))! };
    const record: SignoffRecord = { ...identity, signoffId: `so-${operationId}`, operationId, requestSha256: hash('b'), clientId: CLIENT, caseId: CASE,
      warningFingerprints: [], acknowledgements: [], signer: PRINCIPAL, preparedBy: { issuer: PRINCIPAL.issuer, subject: 'preparer' }, selfApproval: false,
      signedAt: NOW, auditEvent: event(operationId, c.results_version), state: 'recorded', invalidatedAt: null, invalidatedReason: null };
    await this.ledger.recordSignoff(record);
    if (audited) await this.ledger.settleSignoff({ clientId: CLIENT, caseId: CASE, signoffId: record.signoffId });
    return { identity, signoffId: record.signoffId };
  }
  async operation(signed: Awaited<ReturnType<Harness['signed']>>, operationId = 'publish-operation-0001', expected: PublicationState = { kind: 'none' }) {
    const op: OperationRecord = { operationId, requestSha256: hash('c'), clientId: CLIENT, caseId: CASE, kind: 'publish', signoffId: signed.signoffId,
      resultsVersion: signed.identity.resultsVersion, expected, actor: PRINCIPAL, signedIdentity: signed.identity, auditEvent: event(operationId, signed.identity.resultsVersion), at: NOW, state: 'pending', reason: null };
    await this.ledger.beginOperation(op);
    const { state: _state, reason: _reason, ...intent } = op;
    return intent;
  }
  async withdrawal(rv: ResultsVersion, operationId = 'withdraw-operation-0001') {
    const intent: PublicationIntent = { operationId, requestSha256: hash('c'), clientId: CLIENT, caseId: CASE, kind: 'withdraw', signoffId: null,
      resultsVersion: rv, expected: { kind: 'published', resultsVersion: rv }, actor: PRINCIPAL, signedIdentity: null, auditEvent: { ...event(operationId, rv), action: 'publication.withdraw' }, at: NOW };
    await this.ledger.beginOperation({ ...intent, state: 'pending', reason: null }); return intent;
  }
  mutation(intent: PublicationIntent, recheck = async () => {}, sessionId = SESSION): AtomicPublicationMutation {
    return { intent, authority: { clientId: CLIENT, caseId: CASE, principal: PRINCIPAL, sessionId, capability: 'publish' }, recheck };
  }
  pointer() { return this.db.rows('SELECT * FROM rs_publication WHERE case_id = ?', CASE)[0] ?? null; }
  receiptCount() { return this.db.rows('SELECT * FROM pub_apply_receipt').length; }
  async snapshot(candidateId: string): Promise<CandidateSnapshot | null> {
    const a = { clientId: CLIENT, caseId: CASE, candidateId }, before = await d1PublicationSnapshotRevision(this.db, a);
    const row = this.db.rows<{ link_id: string; results_version: ResultsVersion; manifest_sha256: string }>('SELECT * FROM native_import_link WHERE candidate_id = ?', candidateId)[0];
    if (!before || !row) return null;
    const after = await d1PublicationSnapshotRevision(this.db, a); if (before !== after) throw error('snapshot-changed');
    return { link: { linkId: row.link_id, clientId: CLIENT, caseId: CASE, submissionRevisionId: 'submission-1', submissionManifestSha256: sha256(hash('a')),
      candidate: { candidateId, clientId: CLIENT, caseId: CASE, resultsVersion: row.results_version, manifestSha256: sha256(row.manifest_sha256), packageInputRevisionId: id('input-revision', 'input-1') } },
      preparedBy: { issuer: PRINCIPAL.issuer, subject: 'preparer' }, snapshotRevision: before,
      validation: { verdict: 'accept', validatorVersion: 'validator-1', diagnosticsSha256: hash('d'), errorFingerprints: [], warningFingerprints: [] }, trustedBaseline: [],
      requiredSections: [{ key: 'overview', state: 'valid' }], requiredPreviews: [] };
  }
  identity(sessionId = SESSION): Identity { return { kind: 'verified', clientId: CLIENT, principal: PRINCIPAL, sessionId, checkRevocation: async () => { if (this.sessionError) throw this.sessionError; }, authorize: async () => {} }; }
  ports(): NativePublicationPorts { return { clientId: CLIENT, authorize: async () => {}, candidates: { read: (a) => this.snapshot(a.candidateId) }, publisher: this.publisher, ledger: this.ledger,
    audit: { append: async (e) => { const prior = this.events.find((p) => p.eventId === e.eventId); if (!prior) this.events.push(structuredClone(e)); else if (canonical(prior) !== canonical(e)) throw error('audit-conflict'); return { eventId: e.eventId }; } }, now: () => new Date(NOW) }; }
  close() { this.editor.close(); this.db.close(); rmSync(this.dir, { recursive: true, force: true }); }
}
