import type { AuditActor, CaseId, IdentityState } from '../server/runtime/contracts.ts';
import type { Principal } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { canonical, digestOf, type AnyAuditEvent, type AuditLookup, type GrantAuditPort } from './audit.ts';
import type { GrantOperation, GrantRecord, GrantRepository, GrantScope, NewOperation, OperationActor, OperationType } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';
import type { Actor, ManageResult } from './management.ts';

// INTERNAL to grant management and the provisioning bootstrap: the operation ledger, the stable audit event and the settle
// step they share. It is not exported from the tenancy index. It confers no authority by itself: authority is decided by
// the callers (createGrantManagement for an authorised manager, provisioning.ts for the control plane).

/** What every factory needs. `audit` needs `find`: a plain append-only sink cannot prove a lost acknowledgement. */
export interface CommonOptions<P = GrantAuditPort> {
  deployment: ClientResourceIdentity;
  grants: GrantRepository;
  audit: P;
  now: () => Date;
  newGrantId?: () => string;
}
/** The shape the engine needs of any audit port: management's grant port and provisioning's port both satisfy it. */
export type EngineAudit = { append(event: AnyAuditEvent): Promise<{ eventId: string }> } & AuditLookup;

export const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const storage = () => contractError('storage-unavailable', true);
export const same = (a: { issuer: string; subject: string }, b: { issuer: string; subject: string }) => a.issuer === b.issuer && a.subject === b.subject;
export const sameActor = (a: OperationActor, b: OperationActor) => same(a, b) && a.kind === b.kind;
export const isIso = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString() === v; };
/** A caller-supplied id appears in an event only when it is a well-formed id; anything else is not echoed. */
export const label = (v: unknown) => (typeof v === 'string' && OPERATION.test(v) ? v : 'invalid');
export const keyOf = (p: Principal): OperationActor => ({ issuer: p.issuer, subject: p.subject, kind: p.kind });
export const REUSED = { kind: 'conflict', reason: 'operation-reused' } as const;

/** What create, update, revoke and bootstrap share: the ledger, the stable audit event and the settle step. */
export function engine(o: CommonOptions<EngineAudit>) {
  if (typeof o.audit?.append !== 'function' || typeof o.audit?.find !== 'function') {
    throw new TypeError('grant management needs an audit port with append and find(eventId): an append-only sink cannot prove whether a lost acknowledgement persisted');
  }
  const { deployment } = o, clientId = deployment.clientId, newGrantId = o.newGrantId ?? (() => crypto.randomUUID());
  const db = <T>(p: Promise<T>) => p.catch(() => { throw storage(); });
  const who = (a: Actor): IdentityState => ({ kind: 'verified', principal: { issuer: a.principal.issuer, subject: a.principal.subject, kind: a.principal.kind }, sessionId: a.sessionId });
  const caseOf = (scope: GrantScope): CaseId | null => (scope.kind === 'case' ? scope.caseId : null);

  /** Fixes the audit event of an operation: built once, here, and never rebuilt by a retry. */
  async function record(a: { operationId: string; operation: OperationType; actor: OperationActor; identity: AuditActor; action: string; request: string; grantId: string; caseId: CaseId | null }): Promise<NewOperation> {
    const at = o.now().toISOString();
    const event = { eventId: `grant-op:${a.operationId}`, actor: a.identity, action: a.action, object: { kind: 'case-grant', id: a.grantId, caseId: a.caseId }, version: null, outcome: 'succeeded', at } as AnyAuditEvent;
    const json = canonical(event);
    return { operationId: a.operationId, operation: a.operation, actor: a.actor, request: a.request, grantId: a.grantId, event: json, eventDigest: await digestOf(json), recordedAt: at };
  }

  /**
   * Confirms the operation's own recorded event is persisted: looks it up; appends it when absent; after a failed append
   * reads it back. 'ok' only when the stored event is byte-identical (canonical) to the recorded one. Never infers
   * success from a duplicate or an error string. 'mismatch' when the log holds a different event under the id.
   */
  async function persist(op: GrantOperation): Promise<'ok' | 'mismatch' | 'pending'> {
    let event: AnyAuditEvent;
    try {
      event = JSON.parse(op.event) as AnyAuditEvent;
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
