import type { ClientId } from '../server/runtime/contracts.ts';
import type { D1, D1Statement } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { GRANT_ROLES, slotOf, type GrantOperation, type GrantRecord, type GrantRepository, type GrantRole, type GrantScope, type GrantState, type NewGrant, type NewOperation, type OperationType } from './grants.ts';

// GrantRepository over this client's D1 database and the tenant_case_grants table (migrations/0001). Compare-and-set
// writes are conditional statements read back by key, so no outcome depends on a driver's change count. A row that does
// not parse is a fault, never a grant.

type Row = {
  grant_id: string; client_id: string; scope: string; case_id: string | null; issuer: string; subject: string; principal_kind: string;
  role: string; slot: string; state: string; expires_at: string | null; version: number; created_operation_id: string; request: string;
  created_by_issuer: string; created_by_subject: string; created_at: string; supersedes: string | null; revoked_operation_id: string | null; revoked_at: string | null;
};
export const GRANT_COLUMNS = 'grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at, supersedes, revoked_operation_id, revoked_at';
const STATES: readonly GrantState[] = ['pending', 'active', 'revoked'];

export function parseGrant(r: Row): GrantRecord {
  const role = r.role as GrantRole;
  if (!GRANT_ROLES.includes(role) || r.slot !== slotOf(role) || !STATES.includes(r.state as GrantState) || (r.principal_kind !== 'client' && r.principal_kind !== 'staff') || !Number.isInteger(r.version)) throw new Error('malformed grant row');
  const scope: GrantScope = r.scope === 'case' && typeof r.case_id === 'string' ? { kind: 'case', caseId: id('case', r.case_id) } : r.scope === 'client' && r.case_id === null ? { kind: 'client' } : (() => { throw new Error('malformed grant scope'); })();
  return Object.freeze({
    grantId: r.grant_id, clientId: id('client', r.client_id), scope, issuer: r.issuer, subject: r.subject, principalKind: r.principal_kind, role, state: r.state as GrantState,
    expiresAt: r.expires_at, version: r.version, createdOperationId: r.created_operation_id, request: r.request,
    createdBy: { issuer: r.created_by_issuer, subject: r.created_by_subject }, createdAt: r.created_at, supersedes: r.supersedes,
    revokedOperationId: r.revoked_operation_id, revokedAt: r.revoked_at,
  });
}
type OperationRow = {
  operation_id: string; operation: string; actor_issuer: string; actor_subject: string; actor_kind: string; request: string; grant_id: string;
  event_json: string; event_digest: string; state: string; recorded_at: string;
};
const OPERATION_COLUMNS = 'operation_id, operation, actor_issuer, actor_subject, actor_kind, request, grant_id, event_json, event_digest, state, recorded_at';
const OPERATIONS: readonly OperationType[] = ['create', 'update', 'revoke', 'bootstrap'];
function parseOperation(r: OperationRow): GrantOperation {
  if (!OPERATIONS.includes(r.operation as OperationType) || !['client', 'staff', 'control-plane'].includes(r.actor_kind) || (r.state !== 'recorded' && r.state !== 'audited')) throw new Error('malformed operation row');
  return Object.freeze({
    operationId: r.operation_id, operation: r.operation as OperationType, actor: Object.freeze({ issuer: r.actor_issuer, subject: r.actor_subject, kind: r.actor_kind as GrantOperation['actor']['kind'] }),
    request: r.request, grantId: r.grant_id, event: r.event_json, eventDigest: r.event_digest, state: r.state, recordedAt: r.recorded_at,
  });
}
const operationValues = (clientId: string, o: NewOperation) => [clientId, o.operationId, o.operation, o.actor.issuer, o.actor.subject, o.actor.kind, o.request, o.grantId, o.event, o.eventDigest, o.recordedAt];
/** Inserts the ledger row only when the grant change it records is in the batch. A taken operation id is a constraint error, which rolls the whole batch back. */
const OPERATION_INSERT = `INSERT INTO tenant_grant_operations (client_id, ${OPERATION_COLUMNS.replace(', state', '')}, state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded' WHERE EXISTS (`;
/** A constraint violation is a logical conflict (a lost race, a taken slot or operation id); anything else is a storage fault and must surface as one. */
const isConstraint = (e: unknown) => e instanceof Error && /constraint/i.test(e.message);

const values = (g: NewGrant) => [
  g.grantId, g.clientId, g.scope.kind, g.scope.kind === 'case' ? g.scope.caseId : null, g.issuer, g.subject, g.principalKind, g.role, slotOf(g.role),
  g.expiresAt, g.createdOperationId, g.request, g.createdBy.issuer, g.createdBy.subject, g.createdAt, g.supersedes,
];
const INSERT_COLUMNS = 'grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, expires_at, created_operation_id, request, created_by_issuer, created_by_subject, created_at, supersedes, state, version';
const PLACEHOLDERS = Array(16).fill('?').join(', ') + ", 'pending', 1";

export function d1GrantRepository(db: D1): GrantRepository {
  const one = async (sql: string, ...bind: (string | number | null)[]) => { const r = await db.prepare(sql).bind(...bind).first<Row>(); return r ? parseGrant(r) : null; };
  const get = (clientId: ClientId, grantId: string) => one(`SELECT ${GRANT_COLUMNS} FROM tenant_case_grants WHERE client_id = ? AND grant_id = ?`, clientId, grantId);
  const operationOf = async (clientId: ClientId, operationId: string) => {
    const r = await db.prepare(`SELECT ${OPERATION_COLUMNS} FROM tenant_grant_operations WHERE client_id = ? AND operation_id = ?`).bind(clientId, operationId).first<OperationRow>();
    return r ? parseOperation(r) : null;
  };
  const batch = async (statements: D1Statement[]) => {
    try { await db.batch(statements); } catch (e) { if (!isConstraint(e)) throw e; /* rolled back: the read that follows decides */ }
  };
  /** Both the grant change and its ledger row, for this exact operation, or neither. */
  const recorded = async (clientId: ClientId, grantId: string, op: NewOperation) => {
    const stored = await get(clientId, grantId), row = await operationOf(clientId, op.operationId);
    return stored && row && row.grantId === grantId && row.request === op.request && row.eventDigest === op.eventDigest ? stored : null;
  };
  return {
    async grantsOf({ clientId, principal, scope }) {
      const { results } = await db
        .prepare(`SELECT ${GRANT_COLUMNS} FROM tenant_case_grants WHERE client_id = ? AND issuer = ? AND subject = ? AND scope = ? AND ifnull(case_id, '') = ? AND state <> 'revoked'`)
        .bind(clientId, principal.issuer, principal.subject, scope.kind, scope.kind === 'case' ? scope.caseId : '')
        .all<Row>();
      return results.map(parseGrant);
    },
    get: ({ clientId, grantId }) => get(clientId, grantId),
    operationOf: ({ clientId, operationId }) => operationOf(clientId, operationId),
    async insertPending({ grant, operation }) {
      await batch([
        db.prepare(`INSERT INTO tenant_case_grants (${INSERT_COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT DO NOTHING`).bind(...values(grant)),
        db.prepare(`${OPERATION_INSERT}SELECT 1 FROM tenant_case_grants WHERE client_id = ? AND grant_id = ? AND created_operation_id = ?)`).bind(...operationValues(grant.clientId, operation), grant.clientId, grant.grantId, operation.operationId),
      ]);
      const stored = await recorded(grant.clientId, grant.grantId, operation);
      return stored && stored.createdOperationId === grant.createdOperationId ? stored : null;
    },
    async supersede({ clientId, grantId, expectedVersion, replacement, operation, at }) {
      // One D1 batch is one transaction: the old grant is revoked, its pending replacement and the operation row are
      // inserted, or none of it. A constraint error is a lost race or a taken slot; any other error is a storage fault.
      await batch([
        db.prepare("UPDATE tenant_case_grants SET state = 'revoked', version = version + 1, revoked_operation_id = ?, revoked_at = ? WHERE client_id = ? AND grant_id = ? AND version = ? AND state = 'active'")
          .bind(replacement.createdOperationId, at, clientId, grantId, expectedVersion),
        db.prepare(`INSERT INTO tenant_case_grants (${INSERT_COLUMNS}) SELECT ${PLACEHOLDERS} WHERE EXISTS (SELECT 1 FROM tenant_case_grants WHERE client_id = ? AND grant_id = ? AND revoked_operation_id = ?)`)
          .bind(...values(replacement), clientId, grantId, replacement.createdOperationId),
        db.prepare(`${OPERATION_INSERT}SELECT 1 FROM tenant_case_grants WHERE client_id = ? AND grant_id = ? AND supersedes = ?)`).bind(...operationValues(clientId, operation), clientId, replacement.grantId, grantId),
      ]);
      const stored = await recorded(clientId, replacement.grantId, operation);
      return stored && stored.createdOperationId === replacement.createdOperationId && stored.supersedes === grantId ? stored : null;
    },
    async activate({ clientId, grantId, version }) {
      await db.prepare("UPDATE tenant_case_grants SET state = 'active', version = version + 1 WHERE client_id = ? AND grant_id = ? AND version = ? AND state = 'pending'").bind(clientId, grantId, version).run();
      const stored = await get(clientId, grantId);
      return stored?.state === 'active' && stored.version === version + 1 ? stored : null;
    },
    async revoke({ clientId, grantId, expectedVersion, operation, at }) {
      await batch([
        db.prepare("UPDATE tenant_case_grants SET state = 'revoked', version = version + 1, revoked_operation_id = ?, revoked_at = ? WHERE client_id = ? AND grant_id = ? AND version = ? AND state IN ('pending', 'active')")
          .bind(operation.operationId, at, clientId, grantId, expectedVersion),
        db.prepare(`${OPERATION_INSERT}SELECT 1 FROM tenant_case_grants WHERE client_id = ? AND grant_id = ? AND revoked_operation_id = ?)`).bind(...operationValues(clientId, operation), clientId, grantId, operation.operationId),
      ]);
      const stored = await recorded(clientId, grantId, operation);
      return stored?.state === 'revoked' && stored.revokedOperationId === operation.operationId ? stored : null;
    },
    async settle({ clientId, operationId }) {
      await db.prepare("UPDATE tenant_grant_operations SET state = 'audited' WHERE client_id = ? AND operation_id = ? AND state = 'recorded'").bind(clientId, operationId).run();
      return (await operationOf(clientId, operationId))?.state === 'audited';
    },
  };
}
