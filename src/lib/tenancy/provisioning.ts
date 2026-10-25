import type { Principal, SystemAuditActor } from '../server/runtime/contracts.ts';
import type { ProvisioningAuditPort } from './audit.ts';
import { belongs } from './authorizer.ts';
import type { NewGrant, OperationActor } from './grants.ts';
import { OPERATION, engine, type CommonOptions } from './operations.ts';
import type { ManageResult, TargetPrincipal } from './management.ts';

// PROVISIONING ONLY (GRS-114 approved supplemental correction). The control-plane bootstrap that grants the first and
// every further grant-admin. It is deliberately NOT exported from ./index.ts and must never be reachable from request
// code: scripts/ci/hosted-imports.ts fails any hosted-graph edge to this file, by deep import, re-export or dynamic import.
// Its audit port records a system actor (see audit/provisioning.ts); a request audit port refuses that actor.

export type ManagerBootstrapOptions = CommonOptions<ProvisioningAuditPort>;

/**
 * The trusted control-plane authority for management authority itself. Provisioning composes it, from deployment
 * configuration, in a provisioning job; it is not a capability any grant, role or request can confer, and nothing in
 * request-serving code should import it. `operator` is the control plane's own label for the run or operator that
 * performed the bootstrap (recorded in the grant ledger as the control-plane label and in the audit event as a system actor, never as a verified identity): its issuer is `control-plane:<clientId>`,
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
      // Honest attribution: automated provisioning is a SYSTEM actor, not a verified staff principal, and has no session.
      const identity: SystemAuditActor = { kind: 'system', component: 'provisioning', operator: a.operator };
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
