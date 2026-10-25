import { validCaseId, validEventId } from '../server/runtime/audit-identifiers.ts';
import type { CaseId, SystemAuditActor } from '../server/runtime/contracts.ts';
import type { ProvisioningAuditPort } from './audit.ts';
import { belongs } from './authorizer.ts';
import { CASE_ROLES, type CaseDirectory, type CaseRole, type NewGrant, type OperationActor } from './grants.ts';
import type { ManageResult, TargetPrincipal } from './management.ts';
import { OPERATION, engine, isIso, type CommonOptions } from './operations.ts';

// PROVISIONING ONLY. Trusted non-request initial case assignments, never a request or a grant-admin capability.
// Not exported from ./index.ts. Parent integration must deny this file in scripts/ci/hosted-imports.ts before using
// it, and compose it only in the offline owned seed, with the same deployment, grant repository and actual case
// directory as authorization. The audit port is audit/provisioning.ts, never requestAuditSink or a forged requester.

export interface CaseGrantProvisioningOptions extends CommonOptions<ProvisioningAuditPort> { cases: CaseDirectory }
export interface ProvisionCaseGrant {
  operator: string;
  operationId: string;
  target: TargetPrincipal;
  caseId: CaseId;
  role: CaseRole;
  expiresAt: string | null;
}
export const CASE_GRANT_PROVISION_ACTION = 'grant.provision';
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;

/**
 * Control-plane creation only: viewer/editor (one content slot), operator or publisher, for one existing case.
 * No client scope, grant-admin, upload grant, update or revoke. Operator is an honest run label, not an identity.
 * Uses the primary grant engine's existing `create` operation with a distinct request tag, not manager bootstrap.
 */
export function createCaseGrantProvisioning(o: CaseGrantProvisioningOptions) {
  if (typeof o?.cases?.exists !== 'function' || typeof o.grants?.insertPending !== 'function' || typeof o.now !== 'function' || typeof o.deployment?.clientId !== 'string') {
    throw new TypeError('case grant provisioning needs the exact deployment, primary grant repository, actual case directory and clock');
  }
  const e = engine(o), { deployment } = o, { clientId, db } = e;
  return {
    async grantCase(a: ProvisionCaseGrant): Promise<ManageResult> {
      // Copy all request values before awaiting anything, so validation, operation binding and the row agree.
      const operator = a?.operator, operationId = a?.operationId, caseId = a?.caseId, role = a?.role, expiresAt = a?.expiresAt;
      const target = { issuer: a?.target?.issuer, subject: a?.target?.subject, kind: a?.target?.kind };
      if (typeof operator !== 'string' || operator !== operator.trim() || !OPERATION.test(operator)) return { kind: 'invalid', reason: 'operator is invalid' };
      // The engine prefixes the operation id; validate the resulting event id before reserving a slot.
      if (typeof operationId !== 'string' || operationId !== operationId.trim() || !OPERATION.test(operationId) || !validEventId(`grant-op:${operationId}`)) return { kind: 'invalid', reason: 'operationId is invalid' };
      if (!CASE_ROLES.includes(role)) return { kind: 'invalid', reason: 'unknown case role' };
      if (typeof target.subject !== 'string' || target.subject !== target.subject.trim() || !SUBJECT.test(target.subject) || !belongs(deployment, target)) return { kind: 'invalid', reason: 'the target is not a principal of this client or of staff' };
      if (!validCaseId(caseId) || caseId !== caseId.trim()) return { kind: 'invalid', reason: 'caseId is invalid' };
      // Reject undefined (JSON arrays would alias it to null) even on replay. A recorded expiry may pass with time;
      // the exact replay still settles its original operation, but effective() never treats an expired grant as authority.
      if (expiresAt !== null && (typeof expiresAt !== 'string' || !isIso(expiresAt))) return { kind: 'invalid', reason: 'expiresAt must be an exact ISO instant or null' };
      if ((await db(o.cases.exists({ clientId, caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const actor: OperationActor = { issuer: `control-plane:${clientId}`, subject: operator, kind: 'control-plane' };
      const request = JSON.stringify(['case-provision', target.issuer, target.subject, target.kind, role, caseId, expiresAt]);
      const resumed = await e.again(actor, 'create', operationId, request);
      if (resumed) return resumed;
      const expiry = e.checkExpiry(expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      const grantId = e.newGrantId();
      if (!validEventId(grantId) || grantId !== grantId.trim()) throw new TypeError('newGrantId must produce an audit object identifier');
      const identity: SystemAuditActor = { kind: 'system', component: 'provisioning', operator };
      const operation = await e.record({ operationId, operation: 'create', actor, identity, action: CASE_GRANT_PROVISION_ACTION, request, grantId, caseId });
      const grant: NewGrant = {
        grantId, clientId, scope: { kind: 'case', caseId }, issuer: target.issuer, subject: target.subject, principalKind: target.kind, role, expiresAt,
        createdOperationId: operationId, request, createdBy: { issuer: actor.issuer, subject: actor.subject }, createdAt: operation.recordedAt, supersedes: null,
      };
      const stored = await db(o.grants.insertPending({ grant, operation }));
      if (stored) return e.complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await e.again(actor, 'create', operationId, request);
      return raced ?? { kind: 'conflict', reason: 'slot-taken' };
    },
  };
}
