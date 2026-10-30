import { validCaseId, validEventId } from '../server/runtime/audit-identifiers.ts';
import type { CaseId, SystemAuditActor } from '../server/runtime/contracts.ts';
import type { ProvisioningAuditPort } from './audit.ts';
import { belongs } from './authorizer.ts';
import { CASE_ROLES, type CaseDirectory, type CaseRole, type NewGrant, type OperationActor } from './grants.ts';
import type { ManageResult, TargetPrincipal } from './management.ts';
import { OPERATION, engine, isIso, type CommonOptions } from './operations.ts';

// PROVISIONING ONLY. Trusted non-request case assignments and their renewal, never a request or a grant-admin capability.
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
/** The grant to renew, and the exact principal, case and role it must still hold. */
export interface RenewCaseGrant extends ProvisionCaseGrant { grantId: string }
export const CASE_GRANT_PROVISION_ACTION = 'grant.provision';
export const CASE_GRANT_RENEW_ACTION = 'grant.renew';
/** The furthest a renewal may reach from now. */
export const MAX_RENEWAL_MS = 30 * 86_400_000;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;

/** Copies every request value before anything is awaited, so validation, operation binding and the row agree. A string is the refusal. */
function snapshot(a: ProvisionCaseGrant, deployment: CaseGrantProvisioningOptions['deployment']): ProvisionCaseGrant | string {
  const operator = a?.operator, operationId = a?.operationId, caseId = a?.caseId, role = a?.role, expiresAt = a?.expiresAt;
  const target = { issuer: a?.target?.issuer, subject: a?.target?.subject, kind: a?.target?.kind };
  if (typeof operator !== 'string' || operator !== operator.trim() || !OPERATION.test(operator)) return 'operator is invalid';
  // The engine prefixes the operation id; validate the resulting event id before reserving a slot.
  if (typeof operationId !== 'string' || operationId !== operationId.trim() || !OPERATION.test(operationId) || !validEventId(`grant-op:${operationId}`)) return 'operationId is invalid';
  if (!CASE_ROLES.includes(role)) return 'unknown case role';
  if (typeof target.subject !== 'string' || target.subject !== target.subject.trim() || !SUBJECT.test(target.subject) || !belongs(deployment, target)) return 'the target is not a principal of this client or of staff';
  if (!validCaseId(caseId) || caseId !== caseId.trim()) return 'caseId is invalid';
  // Reject undefined (JSON arrays would alias it to null) even on replay. A recorded expiry may pass with time;
  // the exact replay still settles its original operation, but effective() never treats an expired grant as authority.
  if (expiresAt !== null && (typeof expiresAt !== 'string' || !isIso(expiresAt))) return 'expiresAt must be an exact ISO instant or null';
  return { operator, operationId, target: target as TargetPrincipal, caseId, role, expiresAt };
}

function producer(o: CaseGrantProvisioningOptions) {
  if (typeof o?.cases?.exists !== 'function' || typeof o.grants?.insertPending !== 'function' || typeof o.now !== 'function' || typeof o.deployment?.clientId !== 'string') {
    throw new TypeError('case grant provisioning needs the exact deployment, primary grant repository, actual case directory and clock');
  }
  const e = engine(o), { clientId } = e;
  return {
    e,
    control: (operator: string): OperationActor => ({ issuer: `control-plane:${clientId}`, subject: operator, kind: 'control-plane' }),
    identity: (operator: string): SystemAuditActor => ({ kind: 'system', component: 'provisioning', operator }),
    newGrantId() {
      const grantId = e.newGrantId();
      if (!validEventId(grantId) || grantId !== grantId.trim()) throw new TypeError('newGrantId must produce an audit object identifier');
      return grantId;
    },
  };
}

/**
 * Control-plane creation only: viewer/editor (one content slot), operator or publisher, for one existing case.
 * No client scope, grant-admin, upload grant, update or revoke. Operator is an honest run label, not an identity.
 * Uses the primary grant engine's existing `create` operation with a distinct request tag, not manager bootstrap.
 * A refused create records nothing: its operation row is inserted only in the batch that inserts its grant.
 */
export function createCaseGrantProvisioning(o: CaseGrantProvisioningOptions) {
  const p = producer(o), { e } = p, { clientId, db } = e;
  return {
    async grantCase(a: ProvisionCaseGrant): Promise<ManageResult> {
      const r = snapshot(a, o.deployment);
      if (typeof r === 'string') return { kind: 'invalid', reason: r };
      const { operator, operationId, target, caseId, role, expiresAt } = r;
      if ((await db(o.cases.exists({ clientId, caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const actor = p.control(operator);
      const request = JSON.stringify(['case-provision', target.issuer, target.subject, target.kind, role, caseId, expiresAt]);
      const resumed = await e.again(actor, 'create', operationId, request);
      if (resumed) return resumed;
      const expiry = e.checkExpiry(expiresAt);
      if (expiry) return { kind: 'invalid', reason: expiry };
      const grantId = p.newGrantId();
      const operation = await e.record({ operationId, operation: 'create', actor, identity: p.identity(operator), action: CASE_GRANT_PROVISION_ACTION, request, grantId, caseId });
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

/**
 * Control-plane renewal only: gives a principal the role it already holds on a case again, with a later expiry, so an
 * expired grant (which still holds its slot, so grantCase cannot replace it) does not lock its principal out for good.
 * The named grant must be this client's, active, and exactly the requested principal, case and role. The new expiry must
 * be later than the current one and at most MAX_RENEWAL_MS from now. One D1 batch revokes the grant and inserts its
 * pending replacement (`supersedes`) and the `update` operation row; the replacement counts only once its SYSTEM audit
 * event is confirmed, so neither row is authority while the renewal is in flight. Replay, operation-id binding and
 * settlement are the engine's, as for grantCase.
 */
export function createCaseGrantRenewal(o: CaseGrantProvisioningOptions) {
  if (typeof o?.grants?.supersede !== 'function') throw new TypeError('case grant renewal needs the primary grant repository\'s atomic supersede');
  const p = producer(o), { e } = p, { clientId, db } = e;
  return {
    async renewCaseGrant(a: RenewCaseGrant): Promise<ManageResult> {
      const r = snapshot(a, o.deployment), grantId = a?.grantId;
      if (typeof r === 'string') return { kind: 'invalid', reason: r };
      const { operator, operationId, target, caseId, role, expiresAt } = r;
      if (typeof grantId !== 'string' || grantId !== grantId.trim() || !validEventId(grantId)) return { kind: 'invalid', reason: 'grantId is invalid' };
      if (expiresAt === null) return { kind: 'invalid', reason: 'a renewal names a new expiry' };
      if ((await db(o.cases.exists({ clientId, caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const actor = p.control(operator);
      const request = JSON.stringify(['case-renew', grantId, target.issuer, target.subject, target.kind, role, caseId, expiresAt]);
      const resumed = await e.again(actor, 'update', operationId, request);
      if (resumed) return resumed;
      const old = await db(o.grants.get({ clientId, grantId }));
      if (!old || old.clientId !== clientId) return { kind: 'gone' };
      if (old.scope.kind !== 'case' || old.scope.caseId !== caseId || old.role !== role || old.issuer !== target.issuer || old.subject !== target.subject || old.principalKind !== target.kind) {
        return { kind: 'invalid', reason: 'the grant is not that role of that principal on that case' };
      }
      if (old.state !== 'active') return { kind: 'stale' };
      const now = o.now().getTime(), until = Date.parse(expiresAt);
      if (until <= now) return { kind: 'invalid', reason: 'expiresAt is not in the future' };
      if (old.expiresAt === null || !isIso(old.expiresAt) || until <= Date.parse(old.expiresAt)) return { kind: 'invalid', reason: 'a renewal must expire later than the grant it renews' };
      if (until - now > MAX_RENEWAL_MS) return { kind: 'invalid', reason: 'a renewal expires at most 30 days from now' };
      const replacementId = p.newGrantId();
      const operation = await e.record({ operationId, operation: 'update', actor, identity: p.identity(operator), action: CASE_GRANT_RENEW_ACTION, request, grantId: replacementId, caseId });
      const replacement: NewGrant = {
        grantId: replacementId, clientId, scope: old.scope, issuer: old.issuer, subject: old.subject, principalKind: old.principalKind, role: old.role, expiresAt,
        createdOperationId: operationId, request, createdBy: { issuer: actor.issuer, subject: actor.subject }, createdAt: operation.recordedAt, supersedes: old.grantId,
      };
      const stored = await db(o.grants.supersede({ clientId, grantId: old.grantId, expectedVersion: old.version, replacement, operation, at: operation.recordedAt }));
      if (stored) return e.complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await e.again(actor, 'update', operationId, request);
      return raced ?? { kind: 'stale' };
    },
  };
}
