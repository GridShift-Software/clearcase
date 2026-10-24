// UNIT TEST DOUBLES ONLY. A D1 stand-in over node:sqlite and an in-memory stand-in for GRS-115's OriginalIntake
// (declare/put/finalize). They let the intake controller and repository run; they are not Cloudflare D1, not R2 and not
// the GRS-115 adapter, so nothing here is evidence of the real storage boundary. No production path can reach them.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CaseId, ClientId, Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';

type D1Value = string | number | null;
interface Statement { bind(...v: D1Value[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> }

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failNext: RegExp | null = null;
  constructor(migrations: readonly string[]) {
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

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Outcome = { kind: 'declared' | 'stored' | 'finalized'; repeated: boolean } | { kind: 'refused'; reason: string };
interface Declared { caseId: CaseId; operationId: string; assetId: string; filename: string; mediaType: string; size: number; sha256: string }

/** GRS-115's OriginalIntake semantics, in memory: declare first, put verifies the declared digest, finalize binds only this operation's stored bytes. */
export class MemoryOriginals {
  readonly uploads = new Map<string, Declared & { state: 'declared' | 'stored' | 'finalized' }>();
  readonly objects = new Map<string, Uint8Array>();
  readonly bound = new Map<string, string>();
  calls: string[] = [];
  failNext: 'declare' | 'put' | 'finalize' | null = null;
  private fail(step: 'declare' | 'put' | 'finalize') {
    this.calls.push(step);
    if (this.failNext === step) { this.failNext = null; throw Object.assign(new Error('storage-unavailable'), { code: 'storage-unavailable', retryable: true }); }
  }
  async declare(a: Declared): Promise<Outcome> {
    this.fail('declare');
    const k = `${a.caseId}/${a.operationId}`, prior = this.uploads.get(k);
    if (prior) return prior.sha256 === a.sha256 && prior.size === a.size && prior.assetId === a.assetId && prior.filename === a.filename ? { kind: 'declared', repeated: true } : { kind: 'refused', reason: 'operation-reused' };
    this.uploads.set(k, { ...a, state: 'declared' });
    return { kind: 'declared', repeated: false };
  }
  async put(a: { caseId: CaseId; operationId: string; bytes: Uint8Array }): Promise<Outcome> {
    this.fail('put');
    const u = this.uploads.get(`${a.caseId}/${a.operationId}`);
    if (!u) return { kind: 'refused', reason: 'not-declared' };
    if (a.bytes.byteLength !== u.size || sha(a.bytes) !== u.sha256) return { kind: 'refused', reason: 'digest-mismatch' };
    if (u.state !== 'declared') return { kind: 'stored', repeated: true };
    this.objects.set(`orig/${u.sha256}`, new Uint8Array(a.bytes));
    u.state = 'stored';
    return { kind: 'stored', repeated: false };
  }
  async finalize(a: { caseId: CaseId; operationId: string }): Promise<Outcome> {
    this.fail('finalize');
    const u = this.uploads.get(`${a.caseId}/${a.operationId}`);
    if (!u) return { kind: 'refused', reason: 'not-declared' };
    if (u.state === 'declared') return { kind: 'refused', reason: 'digest-mismatch' };
    const repeated = u.state === 'finalized';
    u.state = 'finalized';
    this.bound.set(`${a.caseId}/${u.assetId}`, u.sha256);
    return { kind: 'finalized', repeated };
  }
}

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE_A = id('case', 'case-a') as CaseId;
export const CASE_B = id('case', 'case-b') as CaseId;
const deny = (code: string) => Object.assign(new Error(code), { code, retryable: false });

export function identity(o: { kind?: 'verified' | 'anonymous'; clientId?: ClientId; read?: readonly CaseId[] } = {}): Identity {
  const principal: Principal = { issuer: 'https://issuer.test', subject: 'user-a', kind: 'client' };
  const authorize: Identity['authorize'] = async (a) => { if (!(o.read ?? [CASE_A]).includes(a.caseId)) throw deny('forbidden'); };
  const base = { clientId: o.clientId ?? CLIENT, checkRevocation: async () => {}, authorize };
  return o.kind === 'anonymous'
    ? { ...base, kind: 'anonymous', principal: null, sessionId: null }
    : { ...base, kind: 'verified', principal, sessionId: id('session', '0b7c2f3e-1d2a-4c5b-8e9f-001122334455') as SessionId };
}

/** The separate upload capability: grants exactly the listed cases of the trusted client. */
export function uploadAuthority(cases: readonly CaseId[], calls: unknown[] = []) {
  return async (a: { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }) => {
    calls.push(a);
    if (a.clientId !== CLIENT || !cases.includes(a.caseId)) throw deny('forbidden');
  };
}

/** A synthetic PDF: header, a tiny body and the end-of-file marker. Not case material. */
export function syntheticPdf(tag = 'one'): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% synthetic ClearCase intake fixture ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}
export const hex = sha;

/** A request body that records whether anything pulled from it, and can end early to model an interrupted upload. */
export function trackedBody(bytes: Uint8Array, o: { cutAt?: number; chunk?: number } = {}) {
  const state = { pulled: 0 };
  const end = o.cutAt ?? bytes.byteLength, chunk = o.chunk ?? 16;
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= end) { c.close(); return; }
      const next = Math.min(end, at + chunk);
      state.pulled += next - at;
      c.enqueue(bytes.slice(at, next));
      at = next;
    },
  }, { highWaterMark: 0 }); // pull only when a reader asks, so `pulled` counts what the server consumed, not a prefetch
  return { stream, state };
}
