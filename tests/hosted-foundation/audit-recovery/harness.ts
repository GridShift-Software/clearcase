// Synthetic SQL/component transport only. No Cloudflare D1, Clerk, workerd or deployed acceptance evidence.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, IdentityState, Principal, ResultsVersion, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { id, resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { committedAuditRecovery } from '../../../src/lib/audit/recovery.ts';
import { sha256Hex } from '../../../src/lib/audit/event.ts';
import { d1NativeCandidateRepository } from '../../../src/lib/results-review/native/repository.ts';
import { candidateAuditEvent, recoverNativeCandidateAudits } from '../../../src/lib/results-review/native/audit.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import { d1PublicationPublisher } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import type { PublicationIntent, SignoffIdentity, SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';
import type { CandidateImportLink } from '../../../src/lib/server/runtime/hosted/alpha-contracts.ts';

export const CLIENT = id('client', 'client-a'), CASE = id('case', 'case-a'), OTHER_CASE = id('case', 'case-b');
export const NOW = '2026-10-25T07:00:00.000Z';
export const now = () => new Date('2026-10-26T07:00:00.000Z');
export const SESSION = id('session', 'original-session');
export const PRINCIPAL: Principal = { issuer: 'https://issuer.test', subject: 'operator-original', kind: 'staff' };
export const requester: IdentityState = { kind: 'verified', principal: PRINCIPAL, sessionId: SESSION };
export const hash = (n: string) => n.repeat(64);
export const rv = (n = '1') => resultsVersion(`sha256:${hash(n)}`);
export const config = (maxRows = 1000, clientId = CLIENT) => auditConfig({ clientId, trustedIssuers: [PRINCIPAL.issuer],
  limits: { maxEventBytes: 4096, maxRows, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 10, maxPageRows: 20, maxPagesPerRequest: 5 } });
const migrations = [
  'src/lib/storage/cloud/migrations/0001_rs_results_storage.sql',
  'src/lib/tenancy/migrations/0001_tenant_case_grants.sql',
  'src/lib/tenancy/migrations/0002_tenant_grant_operations.sql',
  'src/lib/results-review/native/migrations/0001_native_candidate_import.sql',
  'src/lib/publication/hosted/migrations/0001_publication_ledger.sql',
  'src/lib/publication/hosted/migrations/0002_atomic_publication.sql',
  'src/lib/audit/migrations/0001_native_audit.sql',
];
type Value = string | number | null;
type Statement = D1Statement & { exec(): { results: unknown[] } };
export class SqlD1 implements D1 {
  readonly sql: DatabaseSync;
  sessions: string[] = [];
  auditFault: 'none' | 'drop' | 'lost-ack' | 'lost-readback' = 'none';
  failAuditReads = false;
  sourceHook: (() => void) | null = null;
  constructor(readonly path: string, migrate = false) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000');
    if (migrate) for (const p of migrations) this.sql.exec(readFileSync(p, 'utf8'));
  }
  withSession(constraint: 'first-primary'): D1 { this.sessions.push(constraint); return this; }
  prepare(sql: string): Statement {
    const make = (values: Value[]): Statement => ({
      bind: (...v) => make(v),
      exec: () => {
        if (this.failAuditReads && /SELECT seq, client_id, canonical, sha256 FROM native_audit_events/.test(sql)) throw new Error('lost readback');
        if (/FROM native_candidate_audit_intent WHERE/.test(sql)) { const hook = this.sourceHook; this.sourceHook = null; hook?.(); }
        if (/^INSERT INTO native_audit_events/.test(sql) && this.auditFault === 'drop') return { results: [] };
        const q = this.sql.prepare(sql);
        if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: q.all(...values) };
        q.run(...values);
        if (/^INSERT INTO native_audit_events/.test(sql)) {
          if (this.auditFault === 'lost-readback') this.failAuditReads = true;
          if (this.auditFault === 'lost-ack' || this.auditFault === 'lost-readback') throw new Error('lost acknowledgement');
        }
        return { results: [] };
      },
      first: async <T>() => (make(values).exec().results[0] ?? null) as T | null,
      all: async <T>() => ({ results: make(values).exec().results as T[] }),
      run: async () => make(values).exec(),
    });
    return make([]);
  }
  async batch(statements: D1Statement[]) {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const out = statements.map((s) => (s as Statement).exec()); this.sql.exec('COMMIT'); return out; }
    catch (e) { this.sql.exec('ROLLBACK'); throw e; }
  }
  insert(table: string, row: Record<string, Value>) {
    const keys = Object.keys(row);
    this.sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  }
  rows<T = Record<string, unknown>>(sql: string, ...values: Value[]): T[] { return this.sql.prepare(sql).all(...values) as T[]; }
  close() { this.sql.close(); }
}
export async function pubEvent(action: string, sourceId: string, version: ResultsVersion, sessionId: SessionId = SESSION): Promise<AuditEvent> {
  return { eventId: `${action.replace('.', '-')}-${sourceId}-${(await sha256Hex(sessionId)).slice(0, 12)}`.slice(0, 128),
    actor: { kind: 'verified', principal: PRINCIPAL, sessionId }, action, object: { kind: 'publication', id: sourceId, caseId: CASE }, version, outcome: 'succeeded', at: NOW };
}

export class World {
  readonly dir = mkdtempSync(join(tmpdir(), 'committed-audit-'));
  readonly path = join(this.dir, 'client.sqlite');
  db = new SqlD1(this.path, true);
  readonly cfg = config();
  get repository() { return d1NativeCandidateRepository(this.db); }
  get ledger() { return d1PublicationLedger(this.db); }
  recovery(maxRows = 1000) { return committedAuditRecovery({ db: this.db, config: config(maxRows), now }); }
  constructor() {
    this.db.insert('rs_storage_identity', { singleton: 1, client_id: CLIENT, layout: 'clearcase.rs/1' });
    this.db.insert('rs_case', { case_id: CASE }); this.db.insert('rs_case', { case_id: OTHER_CASE });
    this.db.insert('tenant_case_grants', { grant_id: 'publisher-grant', client_id: CLIENT, scope: 'case', case_id: CASE,
      issuer: PRINCIPAL.issuer, subject: PRINCIPAL.subject, principal_kind: 'staff', role: 'publisher', slot: 'publisher', state: 'active', expires_at: null,
      version: 1, created_operation_id: 'grant-operation', request: '{}', created_by_issuer: PRINCIPAL.issuer,
      created_by_subject: PRINCIPAL.subject, created_at: NOW, supersedes: null, revoked_operation_id: null, revoked_at: null });
  }
  async ready() { await provisionAuditBinding({ db: this.db, config: this.cfg, now }); return this; }
  async candidate(n = '1', parent: string | null = null) {
    const candidateId = `candidate-${n}`, operationId = `import-operation-${n}`, version = rv(n);
    this.db.insert('rs_results_version', { version_id: version, case_id: CASE, state: 'stored', attempt: 1, operation_id: operationId,
      manifest_sha256: hash(n), input_revision_id: 'input-1', case_label: 'Synthetic', created: NOW, verdict: 'accept', validator_version: 'validator-1',
      diagnostics_sha256: hash('d'), warning_fingerprints: '[]', expected_documents: 0, expected_assets: 0, expected_seeds: 0, expected_files: 0,
      read_model_sha256: hash('e'), overview: '{}', package_bytes: 0, keep: 0, staged_at: NOW, stored_at: NOW, import_seq: Number(n) });
    const origin = parent ? 'correction' : 'import';
    await this.repository.claim({ clientId: CLIENT, caseId: CASE, operationId, kind: origin, operator: PRINCIPAL,
      requestSha256: hash('f'), submissionRevisionId: 'submission-1', baseCandidateId: parent, at: NOW });
    const link: CandidateImportLink = { format: 'clearcase.candidate-import-link/1', linkId: `link-${n}`, clientId: CLIENT, caseId: CASE,
      submissionRevisionId: 'submission-1', submissionManifestSha256: sha256(hash('a')),
      candidate: { clientId: CLIENT, caseId: CASE, candidateId, resultsVersion: version, manifestSha256: sha256(hash(n)), packageInputRevisionId: id('input-revision', 'input-1') },
      coverage: { policy: 'exact-required-file-set/1', mappedOriginals: [], unavailableOriginals: [] }, operator: { ...PRINCIPAL, kind: 'staff' },
      linkedAt: NOW, attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' };
    const event = await candidateAuditEvent({ candidateId, origin, link }, SESSION);
    await this.repository.record({ clientId: CLIENT, caseId: CASE, operationId, origin, parentCandidateId: parent, link, auditEvent: event,
      correction: parent ? { reason: 'Synthetic correction', operator: PRINCIPAL, at: NOW, changes: [{ path: 'data.json', before: null, after: { sha256: hash('b'), size: 2 } }] } : null });
    return this.repository.auditIntent({ clientId: CLIENT, caseId: CASE, candidateId });
  }
  async settleCandidates() { return recoverNativeCandidateAudits({ clientId: CLIENT, caseId: CASE, repository: this.repository, recovery: this.recovery().candidate, limit: 100 }); }
  async signoff(candidateId = 'candidate-1', operationId = 'signoff-operation-0001', eventOverride?: AuditEvent): Promise<SignoffRecord> {
    const c = (await this.repository.candidate({ clientId: CLIENT, caseId: CASE, candidateId }))!;
    const l = c.link;
    const generation = this.db.rows<{ generation: number }>('SELECT generation FROM pub_candidate_generation WHERE candidate_id = ?', candidateId)[0].generation;
    const identity: SignoffIdentity = { candidateId, linkId: l.linkId, submissionRevisionId: l.submissionRevisionId, submissionManifestSha256: l.submissionManifestSha256,
      resultsVersion: l.candidate.resultsVersion, manifestSha256: l.candidate.manifestSha256, packageInputRevisionId: l.candidate.packageInputRevisionId,
      diagnosticsSha256: hash('d'), validatorVersion: 'validator-1', snapshotRevision: `d1:${generation}` };
    const record: SignoffRecord = { ...identity, signoffId: `so-${operationId}`, operationId, requestSha256: hash('b'), clientId: CLIENT, caseId: CASE,
      warningFingerprints: [], acknowledgements: [], signer: PRINCIPAL, preparedBy: PRINCIPAL, selfApproval: true, signedAt: NOW,
      auditEvent: eventOverride ?? await pubEvent('publication.signoff', `so-${operationId}`, identity.resultsVersion), state: 'recorded', invalidatedAt: null, invalidatedReason: null };
    await this.ledger.recordSignoff(record); return record;
  }
  async operation(so: SignoffRecord, operationId = 'publish-operation-0001', kind: 'publish' | 'withdraw' = 'publish'): Promise<PublicationIntent> {
    const { candidateId, linkId, submissionRevisionId, submissionManifestSha256, resultsVersion: version, manifestSha256, packageInputRevisionId, diagnosticsSha256, validatorVersion, snapshotRevision } = so;
    const intent: PublicationIntent = { operationId, requestSha256: hash('c'), clientId: CLIENT, caseId: CASE, kind, signoffId: kind === 'publish' ? so.signoffId : null,
      resultsVersion: version, expected: kind === 'publish' ? { kind: 'none' } : { kind: 'published', resultsVersion: version }, actor: PRINCIPAL,
      signedIdentity: kind === 'publish' ? { candidateId, linkId, submissionRevisionId, submissionManifestSha256, resultsVersion: version, manifestSha256, packageInputRevisionId, diagnosticsSha256, validatorVersion, snapshotRevision } : null,
      auditEvent: await pubEvent(`publication.${kind}`, operationId, version), at: NOW };
    await this.ledger.beginOperation({ ...intent, state: 'pending', reason: null }); return intent;
  }
  async apply(intent: PublicationIntent, sessionId = SESSION) {
    const publisher = d1PublicationPublisher({ db: this.db, clientId: CLIENT, checkSession: async () => {} });
    return publisher[intent.kind]({ intent, authority: { clientId: CLIENT, caseId: CASE, principal: PRINCIPAL, sessionId, capability: 'publish' }, recheck: async () => {} });
  }
  revoke() {
    this.db.insert('pub_session_revocation', { client_id: CLIENT, issuer: PRINCIPAL.issuer, session_id: SESSION, revoked_at: NOW });
    this.db.sql.prepare("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ?, revoked_operation_id = 'revocation-operation', version = version + 1 WHERE grant_id = 'publisher-grant'").run(NOW);
  }
  auditRows() { return this.db.rows<{ event_id: string; canonical: string; sha256: string; at: string; actor_kind: string }>('SELECT * FROM native_audit_events ORDER BY seq'); }
  restart() { this.db.close(); this.db = new SqlD1(this.path); }
  close() { this.db.close(); rmSync(this.dir, { recursive: true, force: true }); }
}
