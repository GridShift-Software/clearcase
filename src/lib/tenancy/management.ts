import type { CaseId, Principal, SessionId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { belongs } from './authorizer.ts';
import { GRANT_ROLES, effective, slotOf, type CaseDirectory, type GrantRecord, type GrantRole, type GrantScope, type NewGrant } from './grants.ts';
import { OPERATION, engine, keyOf, same, type CommonOptions } from './operations.ts';

// Grant management for one client instance. Only an explicit, active grant-admin grant authorizes it, and it never
// reaches case content.
//
// Management authority is not something a manager can bestow. create and update refuse any grant-admin grant, whether
// the target is a colleague, a stranger or an alt account, and refuse any change to an existing grant-admin grant. The
// first and every further grant-admin comes from createManagerBootstrap (provisioning.ts, not exported from the tenancy
// index): a separate, trusted control-plane factory that provisioning composes and request-serving code never holds or
// reaches (the hosted import guard fails any hosted-graph edge to it). Within that, explicit case grants by
// independently authorised managers are legitimate; this code cannot tell whether two humans collude, and makes no claim to.
//
// Every change is compare-and-set on the grant version and keyed by an operation id bound to the actor, kind and request
// that first used it. A create or update takes effect only after its audit event is confirmed persisted (until then the
// grant is pending and grants nothing); a revoke takes effect first, so a failed audit append never leaves access
// standing. The event is fixed and recorded with the change, before any append is tried.

export type Actor = { principal: Principal; sessionId: SessionId };
export type TargetPrincipal = { issuer: string; subject: string; kind: Principal['kind'] };
export type ManageResult =
  | { kind: 'applied'; grant: GrantRecord; repeated: boolean }
  /** The expected version is not the current one, or the grant is not in a state the change applies to. */
  | { kind: 'stale' }
  | { kind: 'gone' }
  /**
   * A live grant already holds the slot; the operation id belongs to another actor, type or request; or the audit log
   * holds a different event under the operation's event id. Nothing about the other operation or grant is returned.
   */
  | { kind: 'conflict'; reason: 'slot-taken' | 'operation-reused' | 'audit-mismatch' }
  | { kind: 'invalid'; reason: string }
  /**
   * The audit event is not confirmed persisted. A create or update is stored pending and grants nothing; a revoke is
   * already in force. Retrying with the same operation id (by the same principal) completes it.
   */
  | { kind: 'audit-pending'; grantId: string; retryable: true };

export interface GrantManagementOptions extends CommonOptions { cases: CaseDirectory }

export function createGrantManagement(o: GrantManagementOptions) {
  const e = engine(o), { deployment } = o, { clientId, db } = e;

  /** The acting principal must belong to this deployment and hold an active, unexpired grant-admin grant. */
  async function manager(actor: Actor, action: string, objectId: string) {
    const principal = actor?.principal ?? null, sessionId = actor?.sessionId ?? null;
    if (!principal || !sessionId || !principal.subject) return e.refuse(actor, action, objectId, 'unauthenticated');
    if (!belongs(deployment, principal)) return e.refuse(actor, action, objectId, 'wrong-client');
    const scope: GrantScope = { kind: 'client' }, now = o.now();
    const rows = await db(o.grants.grantsOf({ clientId, principal: { issuer: principal.issuer, subject: principal.subject }, scope }));
    if (!rows.some((g) => g.role === 'grant-admin' && effective(g, { clientId, principal, scope, now }))) return e.refuse(actor, action, objectId, 'forbidden');
  }

  return {
    /** Grants a case role to a principal of this client or of staff. It never grants grant-admin; that is the bootstrap's. */
    async create(a: { actor: Actor; operationId: string; target: TargetPrincipal; role: GrantRole; caseId: CaseId | null; expiresAt: string | null }): Promise<ManageResult> {
      const action = 'grant.create';
      await manager(a.actor, action, 'new');
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const actor = keyOf(a.actor.principal);
      const request = JSON.stringify(['create', a.target?.issuer, a.target?.subject, a.target?.kind, a.role, a.caseId, a.expiresAt]);
      const resumed = await e.again(actor, 'create', a.operationId, request);
      if (resumed) return resumed;
      if (!GRANT_ROLES.includes(a.role)) return { kind: 'invalid', reason: 'unknown role' };
      if (!a.target || typeof a.target.subject !== 'string' || !a.target.subject || !belongs(deployment, a.target as Principal)) return { kind: 'invalid', reason: 'the target is not a principal of this client or of staff' };
      if (same(a.target, a.actor.principal)) throw contractError('forbidden'); // no self-granting
      if ((a.role === 'grant-admin') !== (a.caseId === null)) return { kind: 'invalid', reason: 'grant-admin is client-wide; every other role names one case' };
      if (a.role === 'grant-admin') return e.refuse(a.actor, action, 'new', 'forbidden'); // a manager cannot mint or delegate management authority
      const expiry = e.checkExpiry(a.expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      if (a.caseId !== null && (await db(o.cases.exists({ clientId, caseId: a.caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const grantId = e.newGrantId();
      const operation = await e.record({ operationId: a.operationId, operation: 'create', actor, identity: e.who(a.actor), action, request, grantId, caseId: a.caseId });
      const grant: NewGrant = {
        grantId, clientId, scope: a.caseId === null ? { kind: 'client' } : { kind: 'case', caseId: a.caseId },
        issuer: a.target.issuer, subject: a.target.subject, principalKind: a.target.kind, role: a.role, expiresAt: a.expiresAt,
        createdOperationId: a.operationId, request, createdBy: { issuer: actor.issuer, subject: actor.subject }, createdAt: operation.recordedAt, supersedes: null,
      };
      const stored = await db(o.grants.insertPending({ grant, operation }));
      if (stored) return e.complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await e.again(actor, 'create', a.operationId, request);
      if (raced) return raced;
      return { kind: 'conflict', reason: 'slot-taken' };
    },
    /** Replaces an active grant's role (within its slot: viewer and editor) or expiry, from the expected version. Never touches grant-admin. */
    async update(a: { actor: Actor; operationId: string; grantId: string; expectedVersion: number; role: GrantRole; expiresAt: string | null }): Promise<ManageResult> {
      const action = 'grant.update';
      await manager(a.actor, action, a.grantId);
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const actor = keyOf(a.actor.principal);
      const request = JSON.stringify(['update', a.grantId, a.expectedVersion, a.role, a.expiresAt]);
      const resumed = await e.again(actor, 'update', a.operationId, request);
      if (resumed) return resumed;
      const old = await db(o.grants.get({ clientId, grantId: a.grantId }));
      if (!old || old.clientId !== clientId) return { kind: 'gone' };
      if (same(old, a.actor.principal)) throw contractError('forbidden'); // no changing one's own grants
      if (old.role === 'grant-admin' || a.role === 'grant-admin') return e.refuse(a.actor, action, a.grantId, 'forbidden'); // no role transition into, or change of, management authority
      if (old.state !== 'active' || old.version !== a.expectedVersion) return { kind: 'stale' };
      if (!GRANT_ROLES.includes(a.role) || slotOf(a.role) !== slotOf(old.role)) return { kind: 'invalid', reason: 'a role changes only within its slot' };
      const expiry = e.checkExpiry(a.expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      const grantId = e.newGrantId();
      const operation = await e.record({ operationId: a.operationId, operation: 'update', actor, identity: e.who(a.actor), action, request, grantId, caseId: e.caseOf(old.scope) });
      const replacement: NewGrant = {
        grantId, clientId, scope: old.scope, issuer: old.issuer, subject: old.subject, principalKind: old.principalKind, role: a.role, expiresAt: a.expiresAt,
        createdOperationId: a.operationId, request, createdBy: { issuer: actor.issuer, subject: actor.subject }, createdAt: operation.recordedAt, supersedes: old.grantId,
      };
      const stored = await db(o.grants.supersede({ clientId, grantId: old.grantId, expectedVersion: a.expectedVersion, replacement, operation, at: operation.recordedAt }));
      if (stored) return e.complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await e.again(actor, 'update', a.operationId, request);
      if (raced) return raced;
      return { kind: 'stale' };
    },
    /** Revokes a pending or active grant at the expected version. In force before its audit event is confirmed. */
    async revoke(a: { actor: Actor; operationId: string; grantId: string; expectedVersion: number }): Promise<ManageResult> {
      const action = 'grant.revoke';
      await manager(a.actor, action, a.grantId);
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const actor = keyOf(a.actor.principal);
      const request = JSON.stringify(['revoke', a.grantId, a.expectedVersion]);
      const resumed = await e.again(actor, 'revoke', a.operationId, request);
      if (resumed) return resumed;
      const old = await db(o.grants.get({ clientId, grantId: a.grantId }));
      if (!old || old.clientId !== clientId) return { kind: 'gone' };
      if (old.state === 'revoked' || old.version !== a.expectedVersion) return { kind: 'stale' };
      const operation = await e.record({ operationId: a.operationId, operation: 'revoke', actor, identity: e.who(a.actor), action, request, grantId: old.grantId, caseId: e.caseOf(old.scope) });
      const revoked = await db(o.grants.revoke({ clientId, grantId: old.grantId, expectedVersion: a.expectedVersion, operation, at: operation.recordedAt }));
      if (revoked) return e.complete({ ...operation, state: 'recorded' }, revoked, false);
      const raced = await e.again(actor, 'revoke', a.operationId, request);
      if (raced) return raced;
      return { kind: 'stale' };
    },
  };
}
