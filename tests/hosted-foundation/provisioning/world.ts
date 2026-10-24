// A synthetic GRS-114 world for unit tests only: node:sqlite behind the D1 shape (a batch is one transaction, as on D1),
// the real tenant_case_grants migration, a manifest of synthetic clients, an in-memory audit sink that can be made to
// fail, and a case directory. None of this is real Clerk, D1 or provisioning evidence.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, AuditSink, CaseId, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import type { GrantRole } from '../../../src/lib/tenancy/grants.ts';
import { createGrantManagement } from '../../../src/lib/tenancy/management.ts';
import { resolveDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';

export const MIGRATION = readFileSync(new URL('../../../src/lib/tenancy/migrations/0001_tenant_case_grants.sql', import.meta.url), 'utf8');
export const ISSUER_A = 'https://client-a.example.test', ISSUER_C = 'https://client-c.example.test', ISSUER_STAFF = 'https://staff.example.test';
export const MANIFEST = {
  staffIssuer: ISSUER_STAFF,
  clients: [
    { clientId: 'client-a', hostname: 'a.clearcase.example.test', worker: 'clearcase-client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'clearcase-client-a', r2Bucket: 'clearcase-client-a', clientIssuer: ISSUER_A },
    { clientId: 'client-c', hostname: 'c.clearcase.example.test', worker: 'clearcase-client-c', d1DatabaseId: '00000000-0000-4000-8000-00000000000c', d1DatabaseName: 'clearcase-client-c', r2Bucket: 'clearcase-client-c', clientIssuer: ISSUER_C },
  ],
};
export const CLIENT_A = id('client', 'client-a'), CASE_1 = id('case', 'case-1'), CASE_2 = id('case', 'case-2');
export const client = (subject: string, issuer = ISSUER_A): Principal => ({ issuer, subject, kind: 'client' });
export const staff = (subject: string, issuer = ISSUER_STAFF): Principal => ({ issuer, subject, kind: 'staff' });
export const SESSION = id('session', 'session-1') as SessionId;
export const SESSION_2 = id('session', 'session-2') as SessionId;

export function d1(db: DatabaseSync): D1 {
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    run: async () => db.prepare(sql).run(...values),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(all) {
      db.exec('BEGIN');
      try { const out = []; for (const s of all) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

export function world(o: { cases?: CaseId[] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  let clock = new Date('2026-10-24T12:00:00.000Z');
  const events: AuditEvent[] = [];
  const state = { auditFails: false, casesFail: false, grantsFail: false, lostAck: false, findFails: false, appends: 0 };
  // The audit stand-in follows the gate's contract: event_id is a primary key, so a repeated append is refused. It can
  // fail before persisting (auditFails), persist and then lose the acknowledgement (lostAck), and answer a lookup by
  // event id (findFails makes that lookup unavailable).
  const unavailable = () => Object.assign(new Error('audit-unavailable'), { code: 'audit-unavailable', retryable: true });
  const audit: AuditSink & { find(eventId: string): Promise<AuditEvent | null> } = {
    async append(e) {
      state.appends++;
      if (state.auditFails) throw unavailable();
      if (events.some((x) => x.eventId === e.eventId)) throw unavailable();
      events.push(structuredClone(e));
      if (state.lostAck) throw unavailable();
      return { eventId: e.eventId };
    },
    async find(eventId) {
      if (state.findFails) throw unavailable();
      const found = events.find((x) => x.eventId === eventId);
      return found ? structuredClone(found) : null;
    },
  };
  const known = new Set<string>(o.cases ?? [CASE_1, CASE_2]);
  const cases = { exists: async (a: { clientId: string; caseId: string }) => { if (state.casesFail) throw new Error('down'); return a.clientId === CLIENT_A && known.has(a.caseId); } };
  const deployment = resolveDeployment(validateClientManifest(MANIFEST), { clientId: 'client-a', worker: 'clearcase-client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', r2Bucket: 'clearcase-client-a' });
  const repo = d1GrantRepository(d1(db));
  const grants: typeof repo = { ...repo, grantsOf: (a) => (state.grantsFail ? Promise.reject(new Error('down')) : repo.grantsOf(a)) };
  const now = () => new Date(clock);
  let n = 0;
  const { authorizeCase, authorizeCapability } = createCaseAuthorizer({ deployment, grants, cases, audit, now });
  const manage = createGrantManagement({ deployment, grants, cases, audit, now, newGrantId: () => `grant-${++n}` });
  /** Provisioning seed: an active grant written straight to the table (the bootstrap path is a parent handoff). */
  function seed(p: Principal, role: GrantRole, caseId: string | null, extra: { clientId?: string; expiresAt?: string | null; state?: string } = {}) {
    const grantId = `seed-${++n}`;
    db.prepare(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', 'seed', 'seed', '2026-10-24T00:00:00.000Z', ?)`).run(
      grantId, extra.clientId ?? 'client-a', caseId === null ? 'client' : 'case', caseId, p.issuer, p.subject, p.kind, role,
      role === 'viewer' || role === 'editor' ? 'content' : role, extra.state ?? 'active', extra.expiresAt ?? null, `seed-op-${n}`, extra.state === 'revoked' ? '2026-10-24T00:00:00.000Z' : null);
    return grantId;
  }
  const rows = () => db.prepare('SELECT grant_id, role, state, version FROM tenant_case_grants ORDER BY grant_id').all();
  const actor = (p: Principal, sessionId: SessionId = SESSION) => ({ principal: p, sessionId });
  return { db, events, audit, state, authorizeCase, authorizeCapability, manage, seed, rows, actor, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
