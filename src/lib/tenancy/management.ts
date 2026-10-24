import type { AuditSink, CaseId, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { belongs } from './authorizer.ts';
import { GRANT_ROLES, effective, slotOf, type CaseDirectory, type GrantRecord, type GrantRepository, type GrantRole, type GrantScope, type NewGrant } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// Grant management for one client instance. Only an explicit, active grant-admin grant authorizes it, and it never
// reaches case content. Every change is compare-and-set on the grant version, keyed by an operation id, and audited:
// a create or update takes effect only after its audit event persists (until then the grant is pending and grants
// nothing); a revoke takes effect first, so a failed audit append never leaves access standing.

export type Actor = { principal: Principal; sessionId: SessionId };
export type TargetPrincipal = { issuer: string; subject: string; kind: Principal['kind'] };
export type ManageResult =
  | { kind: 'applied'; grant: GrantRecord; repeated: boolean }
  /** The expected version is not the current one, or the grant is not in a state the change applies to. */
  | { kind: 'stale' }
  | { kind: 'gone' }
  /** A live grant already holds the slot, or the operation id was used for a different request. */
  | { kind: 'conflict'; reason: 'slot-taken' | 'operation-reused' }
  | { kind: 'invalid'; reason: string }
  /**
   * The audit event did not persist. A create or update is stored pending and grants nothing; a revoke is already in
   * force. Retrying with the same operation id completes it.
   */
  | { kind: 'audit-pending'; grantId: string; retryable: true };

export interface GrantManagementOptions {
  deployment: ClientResourceIdentity;
  grants: GrantRepository;
  cases: CaseDirectory;
  audit: AuditSink;
  now: () => Date;
  newGrantId?: () => string;
}

const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const storage = () => contractError('storage-unavailable', true);
const same = (a: { issuer: string; subject: string }, b: { issuer: string; subject: string }) => a.issuer === b.issuer && a.subject === b.subject;
const isIso = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString() === v; };

export function createGrantManagement(o: GrantManagementOptions) {
  const { deployment } = o, clientId = deployment.clientId, newGrantId = o.newGrantId ?? (() => crypto.randomUUID());
  const db = <T>(p: Promise<T>) => p.catch(() => { throw storage(); });
  const who = (a: Actor): IdentityState => ({ kind: 'verified', principal: { issuer: a.principal.issuer, subject: a.principal.subject, kind: a.principal.kind }, sessionId: a.sessionId });
  const caseOf = (scope: GrantScope): CaseId | null => (scope.kind === 'case' ? scope.caseId : null);

  /** The acting principal must belong to this deployment and hold an active, unexpired grant-admin grant. */
  async function manager(actor: Actor, action: string, object: { id: string; caseId: CaseId | null }) {
    const principal = actor?.principal ?? null, sessionId = actor?.sessionId ?? null;
    const deny = async (code: 'unauthenticated' | 'wrong-client' | 'forbidden') => {
      if (principal && sessionId) await o.audit.append({ eventId: crypto.randomUUID(), actor: who(actor), action, object: { kind: 'case-grant', ...object }, version: null, outcome: 'denied', at: o.now().toISOString() }).catch(() => undefined);
      throw contractError(code);
    };
    if (!principal || !sessionId || !principal.subject) return deny('unauthenticated');
    if (!belongs(deployment, principal)) return deny('wrong-client');
    const scope: GrantScope = { kind: 'client' }, now = o.now();
    const rows = await db(o.grants.grantsOf({ clientId, principal: { issuer: principal.issuer, subject: principal.subject }, scope }));
    if (!rows.some((g) => g.role === 'grant-admin' && effective(g, { clientId, principal, scope, now }))) return deny('forbidden');
  }
  /** Appends the change's event (its id derives from the operation id) and, for a pending grant, then activates it. */
  async function finish(actor: Actor, action: string, operationId: string, grant: GrantRecord, repeated: boolean): Promise<ManageResult> {
    try {
      await o.audit.append({ eventId: `grant-op:${operationId}`, actor: who(actor), action, object: { kind: 'case-grant', id: grant.grantId, caseId: caseOf(grant.scope) }, version: null, outcome: 'succeeded', at: o.now().toISOString() });
    } catch {
      return { kind: 'audit-pending', grantId: grant.grantId, retryable: true };
    }
    if (grant.state !== 'pending') return { kind: 'applied', grant, repeated };
    const active = await db(o.grants.activate({ clientId, grantId: grant.grantId, version: grant.version }));
    if (active) return { kind: 'applied', grant: active, repeated };
    const now = await db(o.grants.get({ clientId, grantId: grant.grantId }));
    return now?.state === 'active' ? { kind: 'applied', grant: now, repeated: true } : { kind: 'stale' };
  }
  /** A retried create or update: the same request completes or reports itself; another request with that id conflicts. */
  async function replay(actor: Actor, action: string, operationId: string, request: string): Promise<ManageResult | null> {
    const prior = await db(o.grants.byOperation({ clientId, operationId }));
    if (!prior) return null;
    if (prior.createdOperationId !== operationId || prior.request !== request) return { kind: 'conflict', reason: 'operation-reused' };
    return prior.state === 'pending' ? finish(actor, action, operationId, prior, true) : { kind: 'applied', grant: prior, repeated: true };
  }
  function checkExpiry(expiresAt: string | null): string | null {
    if (expiresAt === null) return null;
    if (typeof expiresAt !== 'string' || !isIso(expiresAt)) return 'expiresAt must be an exact ISO instant or null';
    return Date.parse(expiresAt) > o.now().getTime() ? null : 'expiresAt is not in the future';
  }

  return {
    /** Grants a role: a case role names a case of this client; grant-admin is client-wide and names none. */
    async create(a: { actor: Actor; operationId: string; target: TargetPrincipal; role: GrantRole; caseId: CaseId | null; expiresAt: string | null }): Promise<ManageResult> {
      const action = 'grant.create';
      await manager(a.actor, action, { id: 'new', caseId: typeof a.caseId === 'string' ? a.caseId : null });
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const request = JSON.stringify(['create', a.target?.issuer, a.target?.subject, a.target?.kind, a.role, a.caseId, a.expiresAt]);
      const replayed = await replay(a.actor, action, a.operationId, request);
      if (replayed) return replayed;
      if (!GRANT_ROLES.includes(a.role)) return { kind: 'invalid', reason: 'unknown role' };
      if (!a.target || typeof a.target.subject !== 'string' || !a.target.subject || !belongs(deployment, a.target as Principal)) return { kind: 'invalid', reason: 'the target is not a principal of this client or of staff' };
      if (same(a.target, a.actor.principal)) throw contractError('forbidden'); // no self-granting
      if ((a.role === 'grant-admin') !== (a.caseId === null)) return { kind: 'invalid', reason: 'grant-admin is client-wide; every other role names one case' };
      const expiry = checkExpiry(a.expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      if (a.caseId !== null && (await db(o.cases.exists({ clientId, caseId: a.caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const grant: NewGrant = {
        grantId: newGrantId(), clientId, scope: a.caseId === null ? { kind: 'client' } : { kind: 'case', caseId: a.caseId },
        issuer: a.target.issuer, subject: a.target.subject, principalKind: a.target.kind, role: a.role, expiresAt: a.expiresAt,
        createdOperationId: a.operationId, request, createdBy: { issuer: a.actor.principal.issuer, subject: a.actor.principal.subject }, createdAt: o.now().toISOString(), supersedes: null,
      };
      const stored = await db(o.grants.insertPending({ grant }));
      if (stored) return finish(a.actor, action, a.operationId, stored, false);
      return (await replay(a.actor, action, a.operationId, request)) ?? { kind: 'conflict', reason: 'slot-taken' };
    },
    /** Replaces an active grant's role (within its slot: viewer and editor) or expiry, from the expected version. */
    async update(a: { actor: Actor; operationId: string; grantId: string; expectedVersion: number; role: GrantRole; expiresAt: string | null }): Promise<ManageResult> {
      const action = 'grant.update';
      await manager(a.actor, action, { id: String(a.grantId), caseId: null });
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const request = JSON.stringify(['update', a.grantId, a.expectedVersion, a.role, a.expiresAt]);
      const replayed = await replay(a.actor, action, a.operationId, request);
      if (replayed) return replayed;
      const old = await db(o.grants.get({ clientId, grantId: a.grantId }));
      if (!old || old.clientId !== clientId) return { kind: 'gone' };
      if (same(old, a.actor.principal)) throw contractError('forbidden'); // no changing one's own grants
      if (old.state !== 'active' || old.version !== a.expectedVersion) return { kind: 'stale' };
      if (!GRANT_ROLES.includes(a.role) || slotOf(a.role) !== slotOf(old.role)) return { kind: 'invalid', reason: 'a role changes only within its slot' };
      const expiry = checkExpiry(a.expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      const at = o.now().toISOString();
      const replacement: NewGrant = {
        grantId: newGrantId(), clientId, scope: old.scope, issuer: old.issuer, subject: old.subject, principalKind: old.principalKind, role: a.role, expiresAt: a.expiresAt,
        createdOperationId: a.operationId, request, createdBy: { issuer: a.actor.principal.issuer, subject: a.actor.principal.subject }, createdAt: at, supersedes: old.grantId,
      };
      const stored = await db(o.grants.supersede({ clientId, grantId: old.grantId, expectedVersion: a.expectedVersion, replacement, at }));
      if (stored) return finish(a.actor, action, a.operationId, stored, false);
      return (await replay(a.actor, action, a.operationId, request)) ?? { kind: 'stale' };
    },
    /** Revokes a pending or active grant at the expected version. In force before its audit event is appended. */
    async revoke(a: { actor: Actor; operationId: string; grantId: string; expectedVersion: number }): Promise<ManageResult> {
      const action = 'grant.revoke';
      await manager(a.actor, action, { id: String(a.grantId), caseId: null });
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const again = async (): Promise<ManageResult | null> => {
        const prior = await db(o.grants.byOperation({ clientId, operationId: a.operationId }));
        if (!prior) return null;
        if (prior.revokedOperationId !== a.operationId || prior.grantId !== a.grantId) return { kind: 'conflict', reason: 'operation-reused' };
        return finish(a.actor, action, a.operationId, prior, true);
      };
      const replayed = await again();
      if (replayed) return replayed;
      const old = await db(o.grants.get({ clientId, grantId: a.grantId }));
      if (!old || old.clientId !== clientId) return { kind: 'gone' };
      if (old.state === 'revoked' || old.version !== a.expectedVersion) return { kind: 'stale' };
      const revoked = await db(o.grants.revoke({ clientId, grantId: old.grantId, expectedVersion: a.expectedVersion, operationId: a.operationId, at: o.now().toISOString() }));
      if (revoked) return finish(a.actor, action, a.operationId, revoked, false);
      return (await again()) ?? { kind: 'stale' };
    },
  };
}
