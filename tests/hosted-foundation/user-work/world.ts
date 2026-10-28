// Synthetic stand-ins for the GRS-117 user-work tests. None of this is evidence of Cloudflare D1, workerd, Clerk or a
// deployed client: D1 is node:sqlite behind D1's prepare/bind/first/all/run/batch, identity and the case reader are
// in-process doubles of the exact runtime port contracts, and every case, ref and digest is invented.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id, resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';

export const MIGRATION = readFileSync(fileURLToPath(new URL('../../../src/lib/user-work/hosted/migrations/0001_uw_user_work.sql', import.meta.url)), 'utf8');
export const CLIENT = id('client', 'client-a'), OTHER_CLIENT = id('client', 'client-b');
export const CASE = id('case', 'synthetic-case'), OTHER_CASE = id('case', 'synthetic-other');
export const RV1 = resultsVersion(`sha256:${'1'.repeat(64)}`), RV2 = resultsVersion(`sha256:${'2'.repeat(64)}`);
export const SHA_A = sha256('a'.repeat(64)), SHA_B = sha256('b'.repeat(64)), SHA_C = sha256('c'.repeat(64));
export const ISSUER = 'https://issuer.example.invalid';
export const LIMITS = { maxStatementsPerBatch: 500, maxSnapshotBytes: 1_000_000 };

export type Fault = {
  /** Every statement fails before it runs. */
  all?: boolean;
  /** The next batch fails before it runs. */
  batchBefore?: boolean;
  /** The next batch commits, then the caller sees an error (a lost acknowledgement). */
  batchAfterCommit?: boolean;
  /** Reads fail after a failed batch (readback impossible). */
  readsAfterBatchFailure?: boolean;
  /** Awaited before each batch runs, so a test can interleave a competing writer. */
  beforeBatch?: () => Promise<void>;
};

export function database(path = ':memory:', migrate = true) {
  const db = new DatabaseSync(path);
  if (migrate) db.exec(MIGRATION);
  return db;
}
export function bind(db: DatabaseSync, client = CLIENT, schemaVersion = 1) {
  db.prepare('INSERT INTO uw_binding (singleton, client_id, schema_version, bound_at) VALUES (1, ?, ?, ?)').run(client, schemaVersion, '2026-10-25T00:00:00.000Z');
}

/** batch() runs its statements in one SQLite transaction, as D1 documents for batch; each run() autocommits. */
export function d1(db: DatabaseSync, fault: Fault = {}): D1 & { statements: string[] } {
  let readsBroken = false;
  const statements: string[] = [];
  const check = () => { if (fault.all || readsBroken) throw new Error('D1_ERROR: unavailable'); };
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement & { exec(): unknown } => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => { check(); statements.push(sql); return (db.prepare(sql).get(...values) as T | undefined) ?? null; },
    all: async <T>() => { check(); statements.push(sql); return { results: db.prepare(sql).all(...values) as T[] }; },
    run: async () => { check(); statements.push(sql); return db.prepare(sql).run(...values); },
    exec: () => { statements.push(sql); return db.prepare(sql).run(...values); },
  });
  return {
    statements,
    prepare: (sql) => statement(sql),
    batch: async (all) => {
      if (fault.beforeBatch) { const hook = fault.beforeBatch; fault.beforeBatch = undefined; await hook(); }
      check();
      if (fault.batchBefore) { fault.batchBefore = false; if (fault.readsAfterBatchFailure) readsBroken = true; throw new Error('D1_ERROR: storage unavailable'); }
      db.exec('BEGIN');
      try {
        const out = all.map((s) => (s as unknown as { exec(): unknown }).exec());
        db.exec('COMMIT');
        // The map-backed audit double publishes events only after the SQL transaction commits.
        for (const s of all) (s as unknown as { afterCommit?: () => void }).afterCommit?.();
        if (fault.batchAfterCommit) { fault.batchAfterCommit = false; if (fault.readsAfterBatchFailure) readsBroken = true; throw new Error('D1_ERROR: network connection lost'); }
        return out;
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    },
  };
}

/** Current, mutable authority: a session, its client membership and per-case roles, all read again on each call. */
export function authority() {
  const state = { revoked: new Set<string>(), grants: new Map<string, 'viewer' | 'editor'>(), identityDown: false, calls: [] as string[] };
  const grantKey = (subject: string, caseId: string) => `${subject}\u0000${caseId}`;
  function identity(subject = 'editor', clientId: C.ClientId = CLIENT, sessionId = `session-${subject}`): C.Identity {
    const session = id('session', sessionId);
    const checkRevocation = async () => {
      state.calls.push(`revocation:${subject}`);
      if (state.identityDown) throw contractError('identity-unavailable', true);
      if (state.revoked.has(sessionId)) throw contractError('invalid-session');
    };
    return {
      kind: 'verified', principal: { issuer: ISSUER, subject, kind: 'client' }, sessionId: session, clientId, checkRevocation,
      async authorize(a) {
        await checkRevocation();
        state.calls.push(`authorize:${subject}:${a.caseId}:${a.operation}`);
        const role = state.grants.get(grantKey(subject, a.caseId));
        if (!role || (a.operation === 'write-user-work' && role !== 'editor')) throw contractError('forbidden');
      },
    };
  }
  return {
    state, identity,
    grant(subject: string, caseId: string, role: 'viewer' | 'editor' | null) { if (role) state.grants.set(grantKey(subject, caseId), role); else state.grants.delete(grantKey(subject, caseId)); },
    revoke(sessionId: string) { state.revoked.add(sessionId); },
  };
}

/** An AuditSink double that stores events by id; the same id with different bytes is refused, as GRS-116 does. */
export function auditLog() {
  const events = new Map<string, C.AuditEvent>();
  const state = { down: false, failAfterStore: false, appends: 0 };
  const sink: C.AuditSink = {
    async atomic({ db: binding, event }) {
      if (state.down) throw contractError('audit-unavailable', true);
      const statement = binding.prepare('INSERT INTO uw_batch_guard (token) SELECT NULL WHERE 0');
      return [Object.assign(statement, { afterCommit: () => { events.set(event.eventId, structuredClone(event)); } })];
    },
    async append(event) {
      state.appends++;
      if (state.down) throw contractError('audit-unavailable', true);
      const prior = events.get(event.eventId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw contractError('audit-conflict');
      events.set(event.eventId, structuredClone(event));
      if (state.failAfterStore) { state.failAfterStore = false; throw contractError('audit-unavailable', true); }
      return { eventId: event.eventId };
    },
  };
  return { sink, events, state };
}

export interface FakeDocument { ref: string; sha256: C.Sha256 | null }
/** The CaseReader methods user work calls, over synthetic versions; every other method refuses. */
export function caseReader(init: { published: C.ResultsVersion | null; versions: Record<string, FakeDocument[]>; seeds?: Record<string, C.SeedRow[]> }) {
  const state = { published: init.published as C.ResultsVersion | null, withdrawn: new Set<string>() };
  const visible = (rv: string) => { if (state.withdrawn.has(rv) || !init.versions[rv]) throw contractError('forbidden'); };
  const reader = new Proxy({} as C.CaseReader, {
    get(_, name) {
      const methods: Partial<Record<keyof C.CaseReader, unknown>> = {
        async documentRow(a: C.VersionScope & { ref: string }) {
          visible(a.resultsVersion);
          const doc = init.versions[a.resultsVersion]!.find((d) => d.ref === a.ref);
          return doc ? { ref: doc.ref, ord: 1, source: 'results', row: {}, list: {}, state: { original: doc.sha256 ? { sha256: doc.sha256 } : null } } : null;
        },
        async fingerprints(a: C.VersionScope) { visible(a.resultsVersion); return init.versions[a.resultsVersion]!.filter((d) => d.sha256).map((d) => ({ ref: d.ref, sha256: d.sha256! })); },
        async documentRows(a: C.VersionScope) { visible(a.resultsVersion); return { rows: [], failed: [] }; },
        async seeds(a: C.VersionScope) { visible(a.resultsVersion); return structuredClone(init.seeds?.[a.resultsVersion] ?? []); },
        async activeVersionId() { return state.published; },
      };
      if (typeof name === 'string' && name in methods) return methods[name as keyof C.CaseReader];
      return async () => { throw new Error(`unexpected CaseReader.${String(name)}`); };
    },
  });
  return { reader, state };
}
