import { validCaseId } from '../server/runtime/audit-identifiers.ts';
import type { AuditSink, CaseId, ClientId, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import { codeOf, contractError } from '../server/runtime/errors.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { belongs } from './authorizer.ts';
import { effective, permits, type CaseDirectory, type GrantRepository } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// NATIVE24: the REQUEST side of the distinct case.upload-originals grant. Reading only: nothing in this file writes a
// grant, binds a database or holds a provisioning port. The grants themselves are issued and revoked by trusted,
// non-request provisioning, whose entry is not exported from the tenancy index.
//
// The capability is its own explicit row for the exact tuple (client, case, issuer, subject, principal kind). It is not a
// case role of the 0001 table, so no viewer, editor, operator, publisher, grant-admin, staff or firm-admin identity implies
// it, and it implies none of them.

export const UPLOAD_GRANT_MIGRATIONS = ['0003_tenant_upload_grants.sql'] as const;
export type UploadGrantState = 'pending' | 'active' | 'revoked';
export type UploadGrantee = { issuer: string; subject: string; kind: Principal['kind'] };

export interface UploadGrant {
  readonly grantId: string;
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly issuer: string;
  readonly subject: string;
  readonly principalKind: Principal['kind'];
  readonly state: UploadGrantState;
  /** ISO instant after which the grant is void; null never expires. */
  readonly expiresAt: string | null;
  readonly version: number;
  readonly createdOperationId: string;
  readonly request: string;
  readonly createdAt: string;
  readonly revokedOperationId: string | null;
  readonly revokedAt: string | null;
}

/**
 * What the request side may read. `heldBy` returns only grants that are active AND whose issue operation is `audited` (the
 * audit event confirmed persisted), for exactly this client, case and grantee. The caller still checks expiry.
 */
export interface UploadGrantReader { heldBy(a: { clientId: ClientId; caseId: CaseId; principal: Principal }): Promise<readonly UploadGrant[]> }
/** Resolves while the session is live; rejects `invalid-session` (or `unauthenticated`) when it is revoked or expired, anything else when the check cannot run. */
export type SessionCheck = (a: { principal: Principal; sessionId: SessionId }) => Promise<void>;
/** Structurally the intake's `AuthorizeUpload` (src/lib/submissions/ports.ts): resolves to allow, rejects with a contract error. */
export type UploadAuthorizer = (a: { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }) => Promise<void>;

export interface UploadAuthorizerOptions {
  /** The validated resource identity of this deployment, from trusted configuration; never a request value. */
  deployment: ClientResourceIdentity;
  /** Explicit case access (GRS-114), with ordered, uncached reads of one database. Grant ids are never reused and
   * versions increase on change: the same active id/version before and after the upload query proves coexistence. */
  grants: Pick<GrantRepository, 'grantsOf'>;
  uploads: UploadGrantReader;
  cases: CaseDirectory;
  session: SessionCheck;
  audit: AuditSink;
  now: () => Date;
  newEventId?: () => string;
}

const ACTION = 'case.upload-originals';
const unavailable = () => contractError('identity-unavailable', true);
const fn = (v: unknown) => typeof v === 'function';

/** A grant counts only when active, unexpired, and exactly this client's, case's and grantee's. */
export function uploadEffective(g: UploadGrant, a: { clientId: ClientId; caseId: CaseId; principal: Principal; now: Date }): boolean {
  if (g.state !== 'active' || g.clientId !== a.clientId || g.caseId !== a.caseId || g.issuer !== a.principal.issuer || g.subject !== a.principal.subject || g.principalKind !== a.principal.kind) return false;
  if (g.expiresAt === null) return true;
  const until = Date.parse(g.expiresAt);
  return Number.isFinite(until) && until > a.now.getTime();
}

/**
 * The upload authority of one client instance, or null when it is not configured (the intake then answers 503 and never
 * allows). Allowed only for a verified principal of this deployment with a live session, explicit current case read
 * access, AND an explicit current upload grant, on a case that exists. Refusals are ContractErrors:
 *
 * - `unauthenticated`: no principal or session. `invalid-session`: the session is revoked or expired (401).
 * - `wrong-client`: the deployment client differs, or the principal is not its kind's principal of this deployment.
 * - `forbidden`: no case access, no upload grant, a revoked, expired, pending or other-case grant, or an unknown case. All
 *   of them are one error, so a refusal reveals nothing about the case, its submissions or why (403).
 * - `identity-unavailable` (retryable): the session check, a grant lookup, the case lookup or the database pin failed.
 * - `audit-unavailable` (retryable): the access event did not persist; an upload is allowed only after that append is acknowledged.
 *
 * A configured authorizer that is missing any dependency refuses to construct; it never degrades to allowing.
 */
export function createUploadAuthorizer(o: UploadAuthorizerOptions | null): UploadAuthorizer | null {
  if (o === null || o === undefined) return null;
  if (typeof o !== 'object' || typeof o.deployment?.clientId !== 'string' || !fn(o.grants?.grantsOf) || !fn(o.uploads?.heldBy) || !fn(o.cases?.exists) || !fn(o.session) || !fn(o.audit?.append) || !fn(o.now)) {
    throw new TypeError('the upload authorizer needs the deployment, case grants, upload grants, a case directory, a session check, an audit sink and a clock');
  }
  const { deployment } = o, clientId = deployment.clientId, eventId = o.newEventId ?? (() => crypto.randomUUID());
  const actor = (principal: Principal | null, sessionId: SessionId | null): IdentityState =>
    principal && sessionId ? { kind: 'verified', principal: { issuer: principal.issuer, subject: principal.subject, kind: principal.kind }, sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
  const event = (who: IdentityState, objectId: string, scoped: CaseId | null, outcome: 'succeeded' | 'denied') =>
    o.audit.append({ eventId: eventId(), actor: who, action: ACTION, object: { kind: 'case', id: objectId, caseId: scoped }, version: null, outcome, at: o.now().toISOString() });

  return async (a) => {
    const principal = a?.principal ?? null, sessionId = a?.sessionId ?? null, who = actor(principal, sessionId);
    const objectId = validCaseId(a?.caseId) ? a.caseId : 'invalid';
    const deny = async (code: 'wrong-client' | 'forbidden', scoped: CaseId | null = null): Promise<never> => {
      await event(who, objectId, scoped, 'denied').catch(() => undefined); // the refusal stands whether or not its event persists
      throw contractError(code);
    };
    if (!principal || !sessionId || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' || !principal.subject) throw contractError('unauthenticated');
    if (a.clientId !== clientId || !belongs(deployment, principal)) return deny('wrong-client');
    if (!validCaseId(a.caseId)) return deny('forbidden');
    try { await o.session({ principal, sessionId }); } catch (e) {
      const code = codeOf(e);
      throw code === 'invalid-session' || code === 'unauthenticated' ? contractError('invalid-session') : unavailable();
    }
    const caseId = a.caseId, scope = { kind: 'case', caseId } as const;
    const access = () => o.grants.grantsOf({ clientId, principal: { issuer: principal.issuer, subject: principal.subject }, scope }).catch(() => { throw unavailable(); });
    // Ordered versioned validation, not independent Promise.all snapshots. The read grant must remain the SAME active
    // row/version across the upload SELECT. GRS-114 revokes/replaces rather than reviving ids, and advances versions on
    // every change. Thus a matching row was live at the upload snapshot; a revoked/replaced grant cannot bridge a gap.
    // All three reads run even when either authority is absent. No cache, replica hopping or unordered reads may sit
    // behind these ports; the D1 adapters use the same primary database (no read-replica session).
    const before = await access();
    const uploads = await o.uploads.heldBy({ clientId, caseId, principal }).catch(() => { throw unavailable(); });
    const after = await access(), now = o.now();
    const readable = (g: (typeof before)[number]) => effective(g, { clientId, principal, scope, now }) && permits(g.role, 'read');
    const reads = after.some((g) => readable(g) && before.some((old) => readable(old) && old.grantId === g.grantId && old.version === g.version));
    const uploaded = uploads.some((g) => uploadEffective(g, { clientId, caseId, principal, now }));
    const exists = async () => (await o.cases.exists({ clientId, caseId }).catch(() => undefined)) === true;
    if (!reads || !uploaded) return deny('forbidden', reads && (await exists()) ? caseId : null);
    const known = await o.cases.exists({ clientId, caseId }).catch(() => { throw unavailable(); });
    if (known !== true) return deny('forbidden');
    await event(who, objectId, caseId, 'succeeded').catch(() => { throw contractError('audit-unavailable', true); });
  };
}

/** Whether a principal holds an effective upload grant for a case: the intake page's question, with no audit and no session or case-access check. */
export type UploadHolding = (a: { principal: Principal; clientId: ClientId; caseId: CaseId }) => Promise<boolean>;

/**
 * An ADVISORY answer for the intake page, so a reader without an upload grant is told so instead of being offered a form.
 * It applies the authorizer's own grant predicate (uploadEffective) to the same reader and decides nothing: it writes no
 * audit event, so a page view never records an upload success or denial, and the caller has already admitted the reader to
 * the case. Every send still runs the audited authorizer. A fault rejects; the caller treats that as "unknown".
 */
export function createUploadHolding(o: { deployment: ClientResourceIdentity; uploads: UploadGrantReader; now: () => Date }): UploadHolding {
  if (typeof o?.deployment?.clientId !== 'string' || !fn(o.uploads?.heldBy) || !fn(o.now)) throw new TypeError('the upload holding check needs the deployment, upload grants and a clock');
  return async ({ principal, clientId, caseId }) => {
    if (clientId !== o.deployment.clientId || !belongs(o.deployment, principal) || !validCaseId(caseId)) return false;
    const held = await o.uploads.heldBy({ clientId, caseId, principal }), now = o.now();
    return held.some((g) => uploadEffective(g, { clientId, caseId, principal, now }));
  };
}

// ---- The D1 reader and the pin both adapters share ------------------------------------------------------------------

export type UploadRow = {
  grant_id: string; client_id: string; case_id: string; issuer: string; subject: string; principal_kind: string; state: string; expires_at: string | null;
  version: number; created_operation_id: string; request: string; created_at: string; revoked_operation_id: string | null; revoked_at: string | null;
};
export const UPLOAD_COLUMNS = 'g.grant_id, g.client_id, g.case_id, g.issuer, g.subject, g.principal_kind, g.state, g.expires_at, g.version, g.created_operation_id, g.request, g.created_at, g.revoked_operation_id, g.revoked_at';
const STATES: readonly UploadGrantState[] = ['pending', 'active', 'revoked'];

/** A row that does not parse, or that is not this client's, is a fault, never a grant. */
export function parseUploadGrant(r: UploadRow, clientId: string): UploadGrant {
  if (r.client_id !== clientId || !STATES.includes(r.state as UploadGrantState) || (r.principal_kind !== 'client' && r.principal_kind !== 'staff') || !Number.isInteger(r.version)) throw new Error('malformed upload grant row');
  return Object.freeze({
    grantId: r.grant_id, clientId: id('client', r.client_id), caseId: id('case', r.case_id), issuer: r.issuer, subject: r.subject, principalKind: r.principal_kind, state: r.state as UploadGrantState,
    expiresAt: r.expires_at, version: r.version, createdOperationId: r.created_operation_id, request: r.request, createdAt: r.created_at, revokedOperationId: r.revoked_operation_id, revokedAt: r.revoked_at,
  });
}

/**
 * Proves, before any query or write, that this database is the one provisioning bound to exactly this client and D1
 * database id. An empty, missing or foreign binding is a fault and is never repaired here: binding is a provisioning step,
 * never something a request does. The binding is immutable, so a success is remembered.
 */
export function uploadPin(db: D1, d: { clientId: string; d1DatabaseId: string }): () => Promise<void> {
  let verified = false;
  return async () => {
    if (verified) return;
    const { results } = await db.prepare('SELECT singleton, client_id, d1_database_id FROM tenant_upload_binding').all<{ singleton: number; client_id: string; d1_database_id: string }>();
    if (results.length !== 1 || results[0].singleton !== 1 || results[0].client_id !== d.clientId || results[0].d1_database_id !== d.d1DatabaseId) throw new Error('the database is not bound to this client');
    verified = true;
  };
}

/** `heldBy` over this client's pinned D1 database: active grants whose issue operation is audited, for the exact tuple. */
export function d1UploadGrantReader(db: D1, deployment: Pick<ClientResourceIdentity, 'clientId' | 'd1DatabaseId'>): UploadGrantReader {
  const pinned = uploadPin(db, deployment);
  return {
    async heldBy({ clientId, caseId, principal }) {
      if (clientId !== deployment.clientId) throw new Error('a foreign client');
      await pinned();
      const { results } = await db
        .prepare(`SELECT ${UPLOAD_COLUMNS} FROM tenant_upload_grants g JOIN tenant_upload_grant_operations o ON o.client_id = g.client_id AND o.operation_id = g.created_operation_id AND o.grant_id = g.grant_id
          WHERE g.client_id = ? AND g.case_id = ? AND g.issuer = ? AND g.subject = ? AND g.principal_kind = ? AND g.state = 'active' AND o.operation = 'issue' AND o.state = 'audited'`)
        .bind(clientId, caseId, principal.issuer, principal.subject, principal.kind)
        .all<UploadRow>();
      return results.map((r) => parseUploadGrant(r, deployment.clientId));
    },
  };
}
