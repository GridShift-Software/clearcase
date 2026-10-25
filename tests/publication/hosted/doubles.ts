// UNIT TEST DOUBLES ONLY. A D1 stand-in over node:sqlite, an in-memory stand-in for the GRS-115 publication pointer,
// a candidate reader, an audit sink and an explicit-grant authorizer. They let the publication controller and its D1
// ledger run; they are not Cloudflare D1, not GRS-115 storage, not GRS-114 grants and not the native audit log, so
// nothing here is evidence of a real boundary. All data is synthetic; no production path can reach these doubles.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditEvent, CaseId, ClientId, Identity, Principal, ResultsVersion, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import type { CandidateSnapshot, PointerOutcome, PublicationState } from '../../../src/lib/publication/hosted/ports.ts';

export const MIGRATIONS: readonly string[] = [path.join(import.meta.dirname, '../../../src/lib/publication/hosted/migrations/0001_publication_ledger.sql')];

type D1Value = string | number | null;
interface Statement { bind(...v: D1Value[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failNext: RegExp | null = null;
  constructor(migrations: readonly string[] = MIGRATIONS) {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const m of migrations) this.sqlite.exec(readFileSync(m, 'utf8'));
  }
  prepare(sql: string): Statement {
    const db = this;
    const make = (values: D1Value[]): Statement & { exec(): unknown[] } => ({
      bind: (...v: D1Value[]) => make(v),
      exec() {
        if (db.failNext?.test(sql)) { db.failNext = null; throw new Error('D1_ERROR: injected failure'); }
        const q = db.sqlite.prepare(sql);
        return /^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql) ? q.all(...values) : (q.run(...values), []);
      },
      async first<T>() { return ((this.exec() as T[])[0] ?? null) as T | null; },
      async all<T>() { return { results: this.exec() as T[] }; },
      async run() { return this.exec(); },
    });
    return make([]);
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as unknown as { exec(): unknown }).exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
  }
  rows<T>(sql: string, ...values: D1Value[]) { return this.sqlite.prepare(sql).all(...values) as T[]; }
  exec(sql: string, ...values: D1Value[]) { this.sqlite.prepare(sql).run(...values); }
}

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE_A = id('case', 'case-a') as CaseId;
export const CASE_B = id('case', 'case-b') as CaseId;
export const ISSUER = 'https://staff-issuer.test';
const hex = (c: string) => c.repeat(64);
export const RV_OLD = resultsVersion(`sha256:${hex('1')}`) as ResultsVersion;
export const RV_NEW = resultsVersion(`sha256:${hex('2')}`) as ResultsVersion;
export const PREPARER: Principal = { issuer: ISSUER, subject: 'operator-p', kind: 'staff' };
export const PUBLISHER: Principal = { issuer: ISSUER, subject: 'publisher-q', kind: 'staff' };
export const STRANGER: Principal = { issuer: ISSUER, subject: 'admin-global', kind: 'staff' };
const deny = (code: string) => Object.assign(new Error(code), { code, retryable: false });

export function identity(o: { principal?: Principal | null; clientId?: ClientId; revoked?: boolean; calls?: string[] } = {}): Identity {
  const principal = o.principal === undefined ? PUBLISHER : o.principal;
  const base = {
    clientId: o.clientId ?? CLIENT,
    checkRevocation: async () => { o.calls?.push('revocation'); if (o.revoked) throw deny('invalid-session'); },
    authorize: async () => { throw deny('forbidden'); },
  };
  return principal === null
    ? { ...base, kind: 'anonymous', principal: null, sessionId: null }
    : { ...base, kind: 'verified', principal, sessionId: id('session', `sess-${principal.subject}`) as SessionId };
}

/** Explicit publish grants only: `subject:caseId`. A staff identity without a row is refused. */
export function grants(rows: readonly string[], calls: string[] = []) {
  const held = new Set(rows);
  return async (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; capability: 'publish' }) => {
    calls.push(`authorize:${a.principal.subject}:${a.caseId}:${a.capability}`);
    if (a.capability !== 'publish' || !held.has(`${a.principal.subject}:${a.caseId}`)) throw deny('forbidden');
  };
}

export class MemoryAudit {
  readonly events: AuditEvent[] = [];
  failNext = 0;
  async append(e: AuditEvent) {
    if (this.failNext > 0) { this.failNext--; throw Object.assign(new Error('audit-unavailable'), { code: 'audit-unavailable', retryable: true }); }
    this.events.push(structuredClone(e));
    return { eventId: e.eventId };
  }
}

/** The GRS-115 pointer, in memory, plus counters that prove originals and user work are never touched. */
export class MemoryPublisher {
  pointer = new Map<string, PublicationState>();
  readonly calls: string[] = [];
  readonly originals = new Map<string, string>([['case-a/orig-1', 'bytes-1']]);
  readonly userWork = new Map<string, string>([['case-a/note-1', 'client note']]);
  failNext: 'publish' | 'withdraw' | null = null;
  current(caseId: string): PublicationState { return this.pointer.get(caseId) ?? { kind: 'none' }; }
  private same(a: PublicationState, b: PublicationState) { return a.kind === b.kind && (a.kind === 'none' || (b.kind !== 'none' && a.resultsVersion === b.resultsVersion)); }
  async publish(a: { caseId: CaseId; resultsVersion: ResultsVersion; manifestSha256: string; expected: PublicationState; operationId: string }): Promise<PointerOutcome> {
    this.calls.push(`publish:${a.caseId}:${a.resultsVersion}`);
    if (this.failNext === 'publish') { this.failNext = null; throw Object.assign(new Error('storage-unavailable'), { code: 'storage-unavailable', retryable: true }); }
    const cur = this.current(a.caseId), next: PublicationState = { kind: 'published', resultsVersion: a.resultsVersion };
    if (this.same(cur, next)) return { kind: 'applied', repeated: true };
    if (!this.same(cur, a.expected)) return { kind: 'conflict', current: cur };
    this.pointer.set(a.caseId, next);
    return { kind: 'applied', repeated: false };
  }
  async withdraw(a: { caseId: CaseId; resultsVersion: ResultsVersion; expected: PublicationState; operationId: string }): Promise<PointerOutcome> {
    this.calls.push(`withdraw:${a.caseId}:${a.resultsVersion}`);
    if (this.failNext === 'withdraw') { this.failNext = null; throw Object.assign(new Error('storage-unavailable'), { code: 'storage-unavailable', retryable: true }); }
    const cur = this.current(a.caseId), next: PublicationState = { kind: 'withdrawn', resultsVersion: a.resultsVersion };
    if (this.same(cur, next)) return { kind: 'applied', repeated: true };
    if (!this.same(cur, a.expected)) return { kind: 'conflict', current: cur };
    this.pointer.set(a.caseId, next);
    return { kind: 'applied', repeated: false };
  }
}

export function snapshot(o: Partial<CandidateSnapshot> & { caseId?: CaseId; candidateId?: string; rv?: ResultsVersion } = {}): CandidateSnapshot {
  const caseId = o.caseId ?? CASE_A, rv = o.rv ?? RV_NEW, candidateId = o.candidateId ?? 'cand-0001';
  return {
    link: {
      linkId: `link-${candidateId}`, clientId: CLIENT, caseId, submissionRevisionId: 'subrev-op-0001-aaaaaaaaaaaaaaaa', submissionManifestSha256: hex('a'),
      candidate: { clientId: CLIENT, caseId, candidateId, resultsVersion: rv, manifestSha256: hex('b') as never, packageInputRevisionId: id('input-revision', 'inrev-1') },
    } as CandidateSnapshot['link'],
    preparedBy: { issuer: ISSUER, subject: PREPARER.subject },
    snapshotRevision: 'snap-1',
    validation: { verdict: 'report', validatorVersion: 'validator-1', diagnosticsSha256: hex('c'), errorFingerprints: [], warningFingerprints: ['f'.repeat(32), 'e'.repeat(32)] },
    trustedBaseline: ['e'.repeat(32)],
    requiredSections: [{ key: 'chronology', state: 'valid' }, { key: 'documents', state: 'valid' }],
    requiredPreviews: [{ assetId: 'orig-1', state: 'rendered' }],
    ...o,
  };
}

export class MemoryCandidates {
  readonly map = new Map<string, unknown>();
  readonly calls: string[] = [];
  put(s: unknown, caseId: string = CASE_A, candidateId = 'cand-0001') { this.map.set(`${caseId}/${candidateId}`, s); }
  async read(a: { clientId: ClientId; caseId: CaseId; candidateId: string }) {
    this.calls.push(`read:${a.caseId}:${a.candidateId}`);
    return a.clientId === CLIENT ? structuredClone(this.map.get(`${a.caseId}/${a.candidateId}`) ?? null) : null;
  }
}

/** A request body that records whether anything pulled from it. */
export function trackedBody(text: string) {
  const bytes = new TextEncoder().encode(text), state = { pulled: 0 };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) { c.close(); return; }
      const next = Math.min(bytes.byteLength, at + 16);
      state.pulled += next - at;
      c.enqueue(bytes.slice(at, next));
      at = next;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}
