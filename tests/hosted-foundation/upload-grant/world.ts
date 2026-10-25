// A synthetic NATIVE24 world for unit tests only: node:sqlite behind the D1 shape (a batch is one transaction, as on D1),
// the real 0001, 0002 and 0003 tenancy migrations, an audit stand-in that follows the real log's two producer modes, a
// session store and a case directory. node:sqlite is a durable-SQLite stand-in, NOT D1 provider evidence, and none of
// this is real Clerk, D1 or provisioning evidence.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, CaseId, Principal, SessionId, SystemAuditEvent } from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import type { GrantRole } from '../../../src/lib/tenancy/grants.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { createUploadAuthorizer, d1UploadGrantReader } from '../../../src/lib/tenancy/upload-capability.ts';
import { bindUploadDatabase, createUploadProvisioning } from '../../../src/lib/tenancy/upload-provisioning.ts';
import { CASE_1, CASE_2, CLIENT_A, ISSUER_A, ISSUER_C, ISSUER_STAFF, MANIFEST, MIGRATIONS, SESSION, SESSION_2, client, d1, staff } from '../provisioning/world.ts';

export { CASE_1, CASE_2, CLIENT_A, ISSUER_A, ISSUER_C, ISSUER_STAFF, SESSION, SESSION_2, client, staff };
export const UPLOAD_MIGRATION = readFileSync(new URL('../../../src/lib/tenancy/migrations/0003_tenant_upload_grants.sql', import.meta.url), 'utf8');
export const OPERATOR = 'provisioning-run-1';
export const TUPLE = (p: Principal) => ({ issuer: p.issuer, subject: p.subject, kind: p.kind });

/** What a caller of the authorizer or of provisioning sees when it is refused: the code, its retryability and its message. */
export async function refusal(p: Promise<unknown>): Promise<{ code: string; retryable: boolean; message: string }> {
  try { await p; } catch (e) { const x = e as { code?: string; retryable?: boolean; message?: string }; return { code: String(x.code), retryable: x.retryable === true, message: String(x.message) }; }
  throw new Error('expected a refusal, but the call resolved');
}

export type Bound = 'client-a' | 'client-c' | 'none';

export async function world(o: { cases?: string[]; bound?: Bound } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec([...MIGRATIONS, UPLOAD_MIGRATION].join('\n'));
  let clock = new Date('2026-10-25T08:00:00.000Z');
  const events: (AuditEvent | SystemAuditEvent)[] = [];
  const state = { auditFails: false, lostAck: false, findFails: false, requestAuditFails: false, casesFail: false, grantsFail: false, uploadsFail: false, sessionFails: false, batchFails: false, appends: 0 };
  const unavailable = () => Object.assign(new Error('audit-unavailable'), { code: 'audit-unavailable', retryable: true });
  const invalid = () => Object.assign(new Error('invalid-event'), { code: 'invalid-event', retryable: false });
  // Follows the gate's contract: event_id is a primary key (a repeat is refused); a request port refuses a system actor and
  // the provisioning port refuses anything else; the log can fail before persisting, or persist and lose the acknowledgement.
  const store = async (e: AuditEvent | SystemAuditEvent, failing: boolean) => {
    state.appends++;
    if (failing) throw unavailable();
    if (events.some((x) => x.eventId === e.eventId)) throw unavailable();
    events.push(structuredClone(e));
    if (state.lostAck) throw unavailable();
    return { eventId: e.eventId };
  };
  const find = async (eventId: string) => {
    if (state.findFails) throw unavailable();
    const found = events.find((x) => x.eventId === eventId);
    return found ? structuredClone(found) : null;
  };
  const requestAudit = { append: async (e: AuditEvent) => { if ((e.actor as { kind: string }).kind === 'system') throw invalid(); return store(e, state.requestAuditFails); } };
  const provisioningAudit = { append: async (e: SystemAuditEvent) => { if ((e.actor as { kind: string }).kind !== 'system') throw invalid(); return store(e, state.auditFails); }, find };
  const known = new Set<string>(o.cases ?? [CASE_1, CASE_2]);
  const cases = { exists: async (a: { clientId: string; caseId: string }) => { if (state.casesFail) throw new Error('down'); return a.clientId === CLIENT_A && known.has(a.caseId); } };
  const deployment = resolveExactDeployment(validateClientManifest(MANIFEST), { clientId: 'client-a', hostname: 'a.clearcase.example.test', d1DatabaseName: 'clearcase-client-a', worker: 'clearcase-client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', r2Bucket: 'clearcase-client-a' });
  const foreign = resolveExactDeployment(validateClientManifest(MANIFEST), { clientId: 'client-c', hostname: 'c.clearcase.example.test', d1DatabaseName: 'clearcase-client-c', worker: 'clearcase-client-c', d1DatabaseId: '00000000-0000-4000-8000-00000000000c', r2Bucket: 'clearcase-client-c' });
  const handle = d1(db, () => state.batchFails);
  const now = () => new Date(clock);
  const revoked = new Set<string>();
  const session = async (a: { principal: Principal; sessionId: SessionId }) => {
    if (state.sessionFails) throw new Error('down');
    if (revoked.has(a.sessionId)) throw contractError('invalid-session');
  };
  const caseGrants = d1GrantRepository(handle);
  const grants = { ...caseGrants, grantsOf: (a: Parameters<typeof caseGrants.grantsOf>[0]) => (state.grantsFail ? Promise.reject(new Error('down')) : caseGrants.grantsOf(a)) };
  const reader = d1UploadGrantReader(handle, deployment);
  const uploads = { heldBy: (a: Parameters<typeof reader.heldBy>[0]) => (state.uploadsFail ? Promise.reject(new Error('down')) : reader.heldBy(a)) };
  let n = 0;
  const authorizeUpload = createUploadAuthorizer({ deployment, grants, uploads, cases, session, audit: requestAudit, now });
  if (!authorizeUpload) throw new Error('the authorizer is configured');
  const provisioning = createUploadProvisioning({ deployment, db: handle, cases, audit: provisioningAudit, now, newGrantId: () => `up-${++n}` });
  const caseAuthorizer = createCaseAuthorizer({ deployment, grants, cases, audit: requestAudit, now });
  const bound = o.bound ?? 'client-a';
  if (bound !== 'none') await bindUploadDatabase(handle, bound === 'client-a' ? deployment : foreign); // explicit provisioning step, never a request's
  /** Case access written straight to the 114 table, as its own tests seed it. */
  function seedCase(p: Principal, role: GrantRole, caseId: string | null, extra: { state?: string; expiresAt?: string | null } = {}) {
    const grantId = `seed-${++n}`;
    db.prepare(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at, revoked_at)
      VALUES (?, 'client-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', 'seed', 'seed', '2026-10-24T00:00:00.000Z', ?)`).run(
      grantId, caseId === null ? 'client' : 'case', caseId, p.issuer, p.subject, p.kind, role, role === 'viewer' || role === 'editor' ? 'content' : role, extra.state ?? 'active', extra.expiresAt ?? null, `seed-op-${n}`, extra.state === 'revoked' ? '2026-10-24T00:00:00.000Z' : null);
    return grantId;
  }
  const rows = () => db.prepare('SELECT grant_id, case_id, issuer, subject, principal_kind, state, version FROM tenant_upload_grants ORDER BY grant_id').all() as { grant_id: string; case_id: string; issuer: string; subject: string; principal_kind: string; state: string; version: number }[];
  const issue = async (p: Principal, caseId: string, operationId: string, extra: { expiresAt?: string | null; operator?: string } = {}) =>
    provisioning.grant({ operator: extra.operator ?? OPERATOR, operationId, target: TUPLE(p), caseId: caseId as CaseId, expiresAt: extra.expiresAt ?? null });
  const request = (p: Principal, caseId: string = CASE_1, sessionId: SessionId = SESSION) => ({ principal: p, sessionId, clientId: CLIENT_A, caseId: caseId as CaseId });
  return {
    db, handle, events, state, revoked, session, deployment, rows, seedCase, issue, request, provisioning, caseAuthorizer,
    authorize: authorizeUpload, audit: provisioningAudit, requestAudit, ledger: () => db.prepare('SELECT operation_id, operation, state, actor_kind, actor_subject FROM tenant_upload_grant_operations ORDER BY operation_id').all(),
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
  };
}
