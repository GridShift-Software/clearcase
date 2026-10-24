import type { AuditEvent, CaseId, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { id } from '../server/runtime/ids.ts';
import { canonical, digestOf, type GrantAuditPort } from './audit.ts';
import { belongs } from './authorizer.ts';
import { GRANT_ROLES, effective, slotOf, type CaseDirectory, type GrantOperation, type GrantRecord, type GrantRepository, type GrantRole, type GrantScope, type NewGrant, type NewOperation, type OperationActor, type OperationType } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// Grant management for one client instance. Only an explicit, active grant-admin grant authorizes it, and it never
// reaches case content.
//
// Management authority is not something a manager can bestow. create and update refuse any grant-admin grant, whether
// the target is a colleague, a stranger or an alt account, and refuse any change to an existing grant-admin grant. The
// first and every further grant-admin comes from createManagerBootstrap: a separate, trusted control-plane factory that
// the deployment's provisioning composes and request-serving code never holds. Within that, explicit case grants by
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

interface CommonOptions {
  deployment: ClientResourceIdentity;
  grants: GrantRepository;
  /** Needs `find`: a plain append-only sink cannot prove a lost acknowledgement, so management refuses to start without it. */
  audit: GrantAuditPort;
  now: () => Date;
  newGrantId?: () => string;
}
export interface GrantManagementOptions extends CommonOptions { cases: CaseDirectory }
export type ManagerBootstrapOptions = CommonOptions;

const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const storage = () => contractError('storage-unavailable', true);
const same = (a: { issuer: string; subject: string }, b: { issuer: string; subject: string }) => a.issuer === b.issuer && a.subject === b.subject;
const sameActor = (a: OperationActor, b: OperationActor) => same(a, b) && a.kind === b.kind;
const isIso = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString() === v; };
/** A caller-supplied id appears in an event only when it is a well-formed id; anything else is not echoed. */
const label = (v: unknown) => (typeof v === 'string' && OPERATION.test(v) ? v : 'invalid');
const keyOf = (p: Principal): OperationActor => ({ issuer: p.issuer, subject: p.subject, kind: p.kind });
const REUSED = { kind: 'conflict', reason: 'operation-reused' } as const;

/** What create, update, revoke and bootstrap share: the ledger, the stable audit event and the settle step. */
function engine(o: CommonOptions) {
  if (typeof o.audit?.append !== 'function' || typeof o.audit?.find !== 'function') {
    throw new TypeError('grant management needs an audit port with append and find(eventId): an append-only sink cannot prove whether a lost acknowledgement persisted');
  }
  const { deployment } = o, clientId = deployment.clientId, newGrantId = o.newGrantId ?? (() => crypto.randomUUID());
  const db = <T>(p: Promise<T>) => p.catch(() => { throw storage(); });
  const who = (a: Actor): IdentityState => ({ kind: 'verified', principal: { issuer: a.principal.issuer, subject: a.principal.subject, kind: a.principal.kind }, sessionId: a.sessionId });
  const caseOf = (scope: GrantScope): CaseId | null => (scope.kind === 'case' ? scope.caseId : null);

  /** Fixes the audit event of an operation: built once, here, and never rebuilt by a retry. */
  async function record(a: { operationId: string; operation: OperationType; actor: OperationActor; identity: IdentityState; action: string; request: string; grantId: string; caseId: CaseId | null }): Promise<NewOperation> {
    const at = o.now().toISOString();
    const event: AuditEvent = { eventId: `grant-op:${a.operationId}`, actor: a.identity, action: a.action, object: { kind: 'case-grant', id: a.grantId, caseId: a.caseId }, version: null, outcome: 'succeeded', at };
    const json = canonical(event);
    return { operationId: a.operationId, operation: a.operation, actor: a.actor, request: a.request, grantId: a.grantId, event: json, eventDigest: await digestOf(json), recordedAt: at };
  }

  /**
   * Confirms the operation's own recorded event is persisted: looks it up; appends it when absent; after a failed append
   * reads it back. 'ok' only when the stored event is byte-identical (canonical) to the recorded one. Never infers
   * success from a duplicate or an error string. 'mismatch' when the log holds a different event under the id.
   */
  async function persist(op: GrantOperation): Promise<'ok' | 'mismatch' | 'pending'> {
    let event: AuditEvent;
    try {
      event = JSON.parse(op.event) as AuditEvent;
      if (canonical(event) !== op.event || (await digestOf(op.event)) !== op.eventDigest) return 'mismatch'; // the recorded row was altered
    } catch { return 'mismatch'; }
    const lookup = async (): Promise<'ok' | 'mismatch' | 'absent' | 'unknown'> => {
      try { const found = await o.audit.find(event.eventId); return found === null ? 'absent' : canonical(found) === op.event ? 'ok' : 'mismatch'; } catch { return 'unknown'; }
    };
    const first = await lookup();
    if (first === 'ok' || first === 'mismatch') return first;
    try {
      await o.audit.append(event); // acknowledged: persisted
      return 'ok';
    } catch {
      const again = await lookup(); // not acknowledged: only a matching stored event is proof
      return again === 'ok' || again === 'mismatch' ? again : 'pending';
    }
  }

  /** Settles an operation: the event must be confirmed persisted before a pending grant activates, and a revoked one never does. */
  async function complete(op: GrantOperation, grant: GrantRecord, repeated: boolean): Promise<ManageResult> {
    if (op.state === 'recorded') {
      if (op.operation !== 'revoke' && grant.state === 'revoked') return { kind: 'stale' }; // revoked before it ever took effect
      const verdict = await persist(op);
      if (verdict === 'mismatch') return { kind: 'conflict', reason: 'audit-mismatch' };
      if (verdict === 'pending') return { kind: 'audit-pending', grantId: grant.grantId, retryable: true };
    }
    let settled = grant;
    if (grant.state === 'pending') {
      const active = await db(o.grants.activate({ clientId, grantId: grant.grantId, version: grant.version }));
      if (active) settled = active;
      else {
        const now = await db(o.grants.get({ clientId, grantId: grant.grantId }));
        if (now?.state !== 'active') return { kind: 'stale' };
        settled = now; repeated = true;
      }
    }
    if (op.state === 'recorded') await db(o.grants.settle({ clientId, operationId: op.operationId }));
    return { kind: 'applied', grant: settled, repeated };
  }

  /**
   * A retried operation: it resumes only for the same client, principal (issuer, subject, kind), type and request that
   * first used the id. Anything else is refused without returning the other operation's grant. The session is not part of
   * the binding: the same principal re-authenticated resumes, with the original event.
   */
  async function resume(actor: OperationActor, type: OperationType, operationId: string, request: string): Promise<{ op: GrantOperation; grant: GrantRecord } | typeof REUSED | null> {
    const op = await db(o.grants.operationOf({ clientId, operationId }));
    if (!op) return null;
    if (op.operation !== type || op.request !== request || !sameActor(op.actor, actor)) return REUSED;
    const grant = await db(o.grants.get({ clientId, grantId: op.grantId }));
    if (!grant) throw storage(); // a ledger row without its grant is a fault, never a result
    return { op, grant };
  }
  /** A retry of an operation: resumed and completed for its original actor; refused for anyone else; null when the id is new. */
  async function again(actor: OperationActor, type: OperationType, operationId: string, request: string): Promise<ManageResult | null> {
    const resumed = await resume(actor, type, operationId, request);
    return resumed === null ? null : 'op' in resumed ? complete(resumed.op, resumed.grant, true) : resumed;
  }
  function checkExpiry(expiresAt: string | null): string | null {
    if (expiresAt === null) return null;
    if (typeof expiresAt !== 'string' || !isIso(expiresAt)) return 'expiresAt must be an exact ISO instant or null';
    return Date.parse(expiresAt) > o.now().getTime() ? null : 'expiresAt is not in the future';
  }
  /** A refusal: recorded, best effort, for a verified actor, never scoped to the case a caller names. */
  async function refuse(actor: Actor | null, action: string, objectId: string, code: 'unauthenticated' | 'wrong-client' | 'forbidden'): Promise<never> {
    const principal = actor?.principal ?? null, sessionId = actor?.sessionId ?? null;
    if (actor && principal && sessionId) await o.audit.append({ eventId: crypto.randomUUID(), actor: who(actor), action, object: { kind: 'case-grant', id: label(objectId), caseId: null }, version: null, outcome: 'denied', at: o.now().toISOString() }).catch(() => undefined);
    throw contractError(code);
  }
  return { clientId, newGrantId, db, who, caseOf, record, complete, again, checkExpiry, refuse };
}

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

/**
 * The trusted control-plane authority for management authority itself. Provisioning composes it, from deployment
 * configuration, in a provisioning job; it is not a capability any grant, role or request can confer, and nothing in
 * request-serving code should import it. `operator` is the control plane's own label for the run or operator that
 * performed the bootstrap (recorded as the actor, not a verified identity): its issuer is `control-plane:<clientId>`,
 * which is neither the client's nor staff's issuer, so it can authorize nothing else. The one thing it does is grant
 * `grant-admin` (client-wide) to a principal of this client or of staff, pending, audited and idempotent like any other
 * change, with the same operation-id binding and the same audit port.
 */
export function createManagerBootstrap(o: ManagerBootstrapOptions) {
  const e = engine(o), { deployment } = o, { clientId, db } = e;
  const control = (operator: string): OperationActor => ({ issuer: `control-plane:${clientId}`, subject: operator, kind: 'control-plane' });
  return {
    async grantManager(a: { operator: string; operationId: string; target: TargetPrincipal; expiresAt: string | null }): Promise<ManageResult> {
      if (typeof a?.operator !== 'string' || !OPERATION.test(a.operator)) return { kind: 'invalid', reason: 'operator is invalid' };
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const actor = control(a.operator), action = 'grant.bootstrap';
      const request = JSON.stringify(['bootstrap', a.target?.issuer, a.target?.subject, a.target?.kind, 'grant-admin', null, a.expiresAt]);
      const resumed = await e.again(actor, 'bootstrap', a.operationId, request);
      if (resumed) return resumed;
      if (!a.target || typeof a.target.subject !== 'string' || !a.target.subject || !belongs(deployment, a.target as Principal)) return { kind: 'invalid', reason: 'the target is not a principal of this client or of staff' };
      const expiry = e.checkExpiry(a.expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      const grantId = e.newGrantId();
      const identity: IdentityState = { kind: 'verified', principal: { issuer: actor.issuer, subject: actor.subject, kind: 'staff' }, sessionId: id('session', `control-plane:${a.operationId}`) };
      const operation = await e.record({ operationId: a.operationId, operation: 'bootstrap', actor, identity, action, request, grantId, caseId: null });
      const grant: NewGrant = {
        grantId, clientId, scope: { kind: 'client' }, issuer: a.target.issuer, subject: a.target.subject, principalKind: a.target.kind, role: 'grant-admin', expiresAt: a.expiresAt,
        createdOperationId: a.operationId, request, createdBy: { issuer: actor.issuer, subject: actor.subject }, createdAt: operation.recordedAt, supersedes: null,
      };
      const stored = await db(o.grants.insertPending({ grant, operation }));
      if (stored) return e.complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await e.again(actor, 'bootstrap', a.operationId, request);
      if (raced) return raced;
      return { kind: 'conflict', reason: 'slot-taken' };
    },
  };
}
