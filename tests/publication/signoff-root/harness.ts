// Synthetic only. The real native schema (every migration the bundle applies) in node:sqlite, a D1-shaped adapter with real batch
// atomicity, U3's real evidence engine writing the evidence, and the real controller, ledger and publisher over it. This is SQLite
// evidence, not Cloudflare D1.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createNativePublication, type PublicationRequest } from '../../../src/lib/publication/hosted/controller.ts';
import { d1PublicationPublisher, d1PublicationSnapshotRevision } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { d1PublicationLedger, type PublicationD1Statement, type PublicationD1Value } from '../../../src/lib/publication/hosted/ledger.ts';
import { createEvidenceEngine, d1EvidenceStore, type EvidenceBinding, type EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1EvidenceReader } from '../../../src/lib/publication/hosted/readiness-evidence.ts';
import type { AuditEvent, CaseId, ClientId, Identity, Principal, ResultsVersion, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import type { CandidateSnapshotV2, NativePublicationPorts } from '../../../src/lib/publication/hosted/ports.ts';
import { database } from '../evidence/harness.ts';
import { fp, observations, type Spec } from '../readiness-v2/harness.ts';

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE = id('case', 'case-a') as CaseId;
export const NOW = '2026-10-27T07:00:00.000Z';
export const PRINCIPAL: Principal = { issuer: 'https://issuer.test', subject: 'publisher-1', kind: 'staff' };
export const PREPARER = { issuer: PRINCIPAL.issuer, subject: 'preparer' };
export const SESSION = id('session', 'sess-publisher-0001') as SessionId;
export const hash = (n: string) => n.repeat(64);
export const CANDIDATE = 'candidate-1';
export const GENERATION = '1';
export const RV: ResultsVersion = resultsVersion(`sha256:${hash('1')}`);

type Value = PublicationD1Value;
const SELECTS = /^\s*(SELECT|WITH)/i, RETURNING = /\bRETURNING\b/i;
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** A D1-shaped adapter over node:sqlite. `batch` is one transaction; `sql` logs every statement; `beforeBatch` runs just before one starts. */
export class Sqlite {
  readonly sql: string[] = [];
  readonly batches: string[][] = [];
  beforeBatch: (() => void) | null = null;
  failReads: RegExp | null = null;
  /** The most bound parameters one statement carried, and the longest bound text, in bytes. */
  readonly widest = { params: 0, bytes: 0 };
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) { this.sqlite = sqlite; }
  withSession(_: 'first-primary') { return this; }
  prepare(sql: string) {
    const db = this;
    const make = (values: Value[]): PublicationD1Statement & { exec(): { results: unknown[]; meta: { changes: number } } } => ({
      bind: (...v: Value[]) => make(v),
      exec() {
        db.sql.push(sql);
        db.widest.params = Math.max(db.widest.params, values.length);
        for (const v of values) if (typeof v === 'string') db.widest.bytes = Math.max(db.widest.bytes, Buffer.byteLength(v));
        if (db.failReads?.test(sql)) throw new Error('injected read failure');
        const q = db.sqlite.prepare(sql);
        if (SELECTS.test(sql) || RETURNING.test(sql)) return { results: q.all(...values), meta: { changes: 0 } };
        return { results: [], meta: { changes: Number(q.run(...values).changes) } };
      },
      first: async <T>() => (make(values).exec().results[0] ?? null) as T | null,
      all: async <T>() => ({ results: make(values).exec().results as T[] }),
      run: async () => make(values).exec(),
    });
    return make([]);
  }
  async batch(statements: PublicationD1Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = null; hook?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    const before = this.sql.length;
    try {
      const results = statements.map(s => (s as unknown as { exec(): unknown }).exec());
      this.sqlite.exec('COMMIT');
      this.batches.push(this.sql.slice(before));
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  exec(sql: string, ...values: Value[]) { this.sqlite.prepare(sql).run(...values); }
  rows<T = Record<string, unknown>>(sql: string, ...values: Value[]): T[] { return this.sqlite.prepare(sql).all(...values) as T[]; }
}

function insert(db: Sqlite, table: string, row: Record<string, Value>) {
  const keys = Object.keys(row);
  db.exec(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]!));
}
const event = (operationId: string, action: string): AuditEvent => ({ eventId: `publication-${operationId}`, actor: { kind: 'verified', principal: PRINCIPAL, sessionId: SESSION },
  action: action as AuditEvent['action'], object: { kind: 'publication', id: operationId, caseId: CASE }, version: RV, outcome: 'succeeded', at: NOW });

export interface Options { spec?: Spec; baseline?: number; evidence?: boolean;
  /** Replaces the producer that walks `observations(spec)`. It must still produce every one of them (warnings are read from `items`), in key order. */
  producer?: EvidenceProducer;
  /** Added to the ports after the defaults (an R2 comparison for `signoffEvidence`, say). */
  originals?: NonNullable<NativePublicationPorts['signoffEvidence']>['originals'] }
export type World = Awaited<ReturnType<typeof world>>;

/** One candidate with a sealed evidence run built by the real engine, a publish grant, and a controller whose ports are real. */
export async function world(options: Options = {}) {
  const raw = database();
  const db = new Sqlite(raw);
  const manifest = hash('1');
  insert(db, 'rs_storage_identity', { singleton: 1, client_id: CLIENT, layout: 'clearcase.rs/1' });
  insert(db, 'rs_case', { case_id: CASE });
  insert(db, 'tenant_case_grants', { grant_id: 'grant-publisher-1', client_id: CLIENT, scope: 'case', case_id: CASE, issuer: PRINCIPAL.issuer, subject: PRINCIPAL.subject,
    principal_kind: PRINCIPAL.kind, role: 'publisher', slot: 'publisher', state: 'active', expires_at: null, version: 1, created_operation_id: 'create-grant-publisher-1', request: '{}',
    created_by_issuer: PRINCIPAL.issuer, created_by_subject: PRINCIPAL.subject, created_at: NOW, supersedes: null, revoked_operation_id: null, revoked_at: null });
  insert(db, 'rs_results_version', { version_id: RV, case_id: CASE, state: 'stored', attempt: 1, operation_id: 'import-operation-1', manifest_sha256: manifest, input_revision_id: 'input-1',
    case_label: 'Synthetic case', created: NOW, verdict: 'accept', validator_version: 'validator-1', diagnostics_sha256: hash('d'), warning_fingerprints: '[]', expected_documents: 0,
    expected_assets: 0, expected_seeds: 0, expected_files: 0, read_model_sha256: hash('e'), overview: '{}', package_bytes: 0, keep: 0, staged_at: NOW, stored_at: NOW, import_seq: 1 });
  insert(db, 'native_import_attempt', { client_id: CLIENT, case_id: CASE, operation_id: 'import-operation-1', kind: 'import', operator_issuer: PREPARER.issuer, operator_subject: PREPARER.subject,
    request_sha256: hash('f'), submission_revision_id: 'submission-1', base_candidate_id: null, declared_at: NOW });
  insert(db, 'native_candidate', { client_id: CLIENT, case_id: CASE, candidate_id: CANDIDATE, results_version: RV, manifest_sha256: manifest, input_revision_id: 'input-1', origin: 'import',
    parent_candidate_id: null, operation_id: 'import-operation-1', created_at: NOW });
  const link = { format: 'clearcase.candidate-import-link/1', linkId: 'link-1', clientId: CLIENT, caseId: CASE, submissionRevisionId: 'submission-1', submissionManifestSha256: hash('a'),
    candidate: { clientId: CLIENT, caseId: CASE, candidateId: CANDIDATE, resultsVersion: RV, manifestSha256: manifest, packageInputRevisionId: 'input-1' },
    coverage: { kind: 'synthetic' }, operator: { issuer: PREPARER.issuer, subject: PREPARER.subject, kind: 'staff' }, linkedAt: NOW,
    attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' };
  insert(db, 'native_import_link', { client_id: CLIENT, case_id: CASE, link_id: link.linkId, candidate_id: CANDIDATE, submission_revision_id: link.submissionRevisionId,
    submission_manifest_sha256: link.submissionManifestSha256, results_version: RV, manifest_sha256: manifest, input_revision_id: 'input-1', coverage_json: JSON.stringify(link.coverage),
    operator_issuer: PREPARER.issuer, operator_subject: PREPARER.subject, linked_at: NOW, link_sha256: createHash('sha256').update(canonical(link)).digest('hex') });
  const audit = { ...event('candidate-import-1', 'results.import') }, eventJson = canonical(audit);
  insert(db, 'native_candidate_audit_intent', { client_id: CLIENT, case_id: CASE, candidate_id: CANDIDATE, event_id: audit.eventId, event_json: eventJson,
    event_sha256: createHash('sha256').update(eventJson).digest('hex') });
  insert(db, 'native_candidate_audit_settlement', { client_id: CLIENT, case_id: CASE, candidate_id: CANDIDATE, event_id: audit.eventId });

  // The evidence, built by U3's engine in bounded steps exactly as a real build would.
  const items = observations(options.spec ?? { previews: 20, warnings: 30 });
  const binding: EvidenceBinding = { candidateId: CANDIDATE, generation: GENERATION, clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: manifest,
    validatorVersion: 'validator-1', rendererVersion: 'renderer/1' };
  const store = d1EvidenceStore(db);
  let clock = 0, root: string | null = null;
  const engine = createEvidenceEngine({ binding, store, clock: () => clock, leaseId: 'builder', leaseMs: 1_000_000, bounds: { itemsPerStep: 500, bytesPerStep: 1024 * 1024 },
    producer: options.producer ?? (async cursor => { const n = cursor === null ? 0 : Number(cursor), item = items[n]; return item ? { done: false, nextCursor: String(n + 1), key: item.key, observation: item.observation } : { done: true }; }) });
  for (let step = 0; step < 200 && root === null; step++) { const r = await engine.step(); if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind); clock++; }
  if (!root) throw new Error('evidence did not complete');
  // The first `baseline` warnings are already accepted for the case; every other warning needs an acknowledgement.
  for (let n = 0; n < (options.baseline ?? 10); n++) insert(db, 'rs_trusted_fingerprint', { case_id: CASE, fingerprint: fp(n) });

  const reader = d1EvidenceReader(db);
  let flipV1 = false, frozen: unknown = null;
  const snapshot = async (): Promise<unknown> => {
    if (frozen) return structuredClone(frozen);
    const revision = await d1PublicationSnapshotRevision(db, { clientId: CLIENT, caseId: CASE, candidateId: CANDIDATE });
    const summary = await reader.summary({ clientId: CLIENT, caseId: CASE, candidateId: CANDIDATE, generation: GENERATION });
    if (!revision || !summary) throw new Error('no snapshot');
    if (flipV1) return { link: v2Link(), preparedBy: PREPARER, snapshotRevision: revision, validation: { verdict: 'accept', validatorVersion: 'validator-1', diagnosticsSha256: hash('d'), errorFingerprints: [], warningFingerprints: [] },
      trustedBaseline: [], requiredSections: [{ key: 'matter', state: 'valid' }], requiredPreviews: [] };
    const v2: CandidateSnapshotV2 = { format: 'clearcase.candidate-snapshot/2', link: v2Link(), preparedBy: PREPARER, snapshotRevision: revision,
      validation: { verdict: 'accept', validatorVersion: 'validator-1', diagnosticsSha256: hash('d') },
      evidence: { generation: GENERATION, root: summary.root, items: summary.items, groups: summary.groups, newWarnings: summary.newWarnings } };
    return v2;
  };
  function v2Link() {
    return { linkId: link.linkId, clientId: CLIENT, caseId: CASE, submissionRevisionId: link.submissionRevisionId, submissionManifestSha256: link.submissionManifestSha256,
      candidate: { clientId: CLIENT, caseId: CASE, candidateId: CANDIDATE, resultsVersion: RV, manifestSha256: manifest, packageInputRevisionId: 'input-1' } } as unknown as CandidateSnapshotV2['link'];
  }

  const events: AuditEvent[] = [];
  const checks: unknown[] = [];
  const ledger = d1PublicationLedger(db, { evidence: options.evidence ?? true });
  const publisher = d1PublicationPublisher({ db, clientId: CLIENT, checkSession: async authority => { checks.push(authority); } });
  const ports: NativePublicationPorts = { clientId: CLIENT, authorize: async () => {}, candidates: { read: async () => snapshot() }, publisher, ledger,
    audit: { append: async e => { if (!events.some(p => p.eventId === e.eventId)) events.push(structuredClone(e)); return { eventId: e.eventId }; } }, now: () => new Date(NOW),
    signoffEvidence: { reader, store, ...(options.originals ? { originals: options.originals } : {}) } };
  const controller = createNativePublication(ports);

  const identity: Identity = { kind: 'verified', clientId: CLIENT, principal: PRINCIPAL, sessionId: SESSION, checkRevocation: async () => {}, authorize: async () => {} };
  const request = (route: 'signoffs' | 'publish', body: unknown): PublicationRequest => {
    const url = new URL(`https://client.test/operator/publication/${CASE}/${route}`);
    return { request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, params: { caseId: CASE }, identity };
  };
  const read = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
  const current = async () => (await snapshot()) as CandidateSnapshotV2;
  const claimed = async () => { const s = await current(); return { linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
    resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
    diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision, evidenceRoot: s.evidence.root }; };

  /** Every warning the baseline does not hold, as the publisher would list them. */
  const fresh = (): string[] => items.filter(i => i.key.startsWith('warning/')).map(i => (i.observation as { fingerprint: string }).fingerprint)
    .filter(f => !db.rows('SELECT 1 FROM rs_trusted_fingerprint WHERE case_id = ? AND fingerprint = ?', CASE, f).length);
  const groups = (parts = 2, reason = 'Reviewed with the client.') => {
    const all = fresh();
    return Array.from({ length: parts }, (_, p) => ({ code: p === 0 ? 'DS_UNSUPPORTED_FIELD' : 'V5_META_COUNT_DISAGREEMENT', reason: `${reason} ${p}`,
      fingerprints: all.filter((_, n) => n % parts === p) })).filter(g => g.fingerprints.length);
  };
  let n = 0;
  const op = (prefix: string) => `${prefix}-operation-${String(++n).padStart(8, '0')}`;
  const signOff = async (over: Record<string, unknown> = {}) => read(await controller.signOff(request('signoffs', {
    operationId: op('signoff'), candidateId: CANDIDATE, identity: over.identity ?? await claimed(), acknowledgements: groups(), selfApproval: false, ...over }) as PublicationRequest));
  const publish = async (signoffId: string, over: Record<string, unknown> = {}) => read(await controller.publish(request('publish', {
    operationId: op('publish'), signoffId, expected: { kind: 'none' }, ...over }) as PublicationRequest));
  const pointer = () => db.rows('SELECT * FROM rs_publication WHERE case_id = ?', CASE)[0] ?? null;
  const receipts = () => db.rows('SELECT * FROM pub_apply_receipt');
  const signoffRow = (signoffId: string) => db.rows<Record<string, string | null>>('SELECT * FROM pub_signoff WHERE signoff_id = ?', signoffId)[0]!;

  return { raw, db, items, binding, store, reader, root, ports, controller, request, signOff, publish, pointer, receipts, signoffRow, groups, fresh, current, claimed, events, checks, read,
    flipSnapshotToV1: () => { flipV1 = true; },
    /** The candidate reader keeps answering with the snapshot it gives now: a reader that cached, or read before the change. */
    freezeSnapshot: async () => { frozen = await snapshot(); } };
}
