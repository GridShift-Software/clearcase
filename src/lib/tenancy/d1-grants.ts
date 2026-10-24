import type { ClientId } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { GRANT_ROLES, slotOf, type GrantRecord, type GrantRepository, type GrantRole, type GrantScope, type GrantState, type NewGrant } from './grants.ts';

// GrantRepository over this client's D1 database and the tenant_case_grants table (migrations/0001). Compare-and-set
// writes are conditional statements read back by key, so no outcome depends on a driver's change count. A row that does
// not parse is a fault, never a grant.

type Row = {
  grant_id: string; client_id: string; scope: string; case_id: string | null; issuer: string; subject: string; principal_kind: string;
  role: string; slot: string; state: string; expires_at: string | null; version: number; created_operation_id: string; request: string;
  created_by_issuer: string; created_by_subject: string; created_at: string; supersedes: string | null; revoked_operation_id: string | null; revoked_at: string | null;
};
const COLUMNS = 'grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at, supersedes, revoked_operation_id, revoked_at';
const STATES: readonly GrantState[] = ['pending', 'active', 'revoked'];

function parse(r: Row): GrantRecord {
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
const values = (g: NewGrant) => [
  g.grantId, g.clientId, g.scope.kind, g.scope.kind === 'case' ? g.scope.caseId : null, g.issuer, g.subject, g.principalKind, g.role, slotOf(g.role),
  g.expiresAt, g.createdOperationId, g.request, g.createdBy.issuer, g.createdBy.subject, g.createdAt, g.supersedes,
];
const INSERT_COLUMNS = 'grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, expires_at, created_operation_id, request, created_by_issuer, created_by_subject, created_at, supersedes, state, version';
const PLACEHOLDERS = Array(16).fill('?').join(', ') + ", 'pending', 1";

export function d1GrantRepository(db: D1): GrantRepository {
  const one = async (sql: string, ...bind: (string | number | null)[]) => { const r = await db.prepare(sql).bind(...bind).first<Row>(); return r ? parse(r) : null; };
  const get = (clientId: ClientId, grantId: string) => one(`SELECT ${COLUMNS} FROM tenant_case_grants WHERE client_id = ? AND grant_id = ?`, clientId, grantId);
  return {
    async grantsOf({ clientId, principal, scope }) {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM tenant_case_grants WHERE client_id = ? AND issuer = ? AND subject = ? AND scope = ? AND ifnull(case_id, '') = ? AND state <> 'revoked'`)
        .bind(clientId, principal.issuer, principal.subject, scope.kind, scope.kind === 'case' ? scope.caseId : '')
        .all<Row>();
      return results.map(parse);
    },
    get: ({ clientId, grantId }) => get(clientId, grantId),
    byOperation: ({ clientId, operationId }) =>
      one(`SELECT ${COLUMNS} FROM tenant_case_grants WHERE client_id = ? AND (created_operation_id = ? OR revoked_operation_id = ?) ORDER BY created_operation_id = ? DESC LIMIT 1`, clientId, operationId, operationId, operationId),
    async insertPending({ grant }) {
      await db.prepare(`INSERT INTO tenant_case_grants (${INSERT_COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT DO NOTHING`).bind(...values(grant)).run();
      const stored = await get(grant.clientId, grant.grantId);
      return stored && stored.createdOperationId === grant.createdOperationId ? stored : null;
    },
    async supersede({ clientId, grantId, expectedVersion, replacement, at }) {
      // One D1 batch is one transaction: the old grant is revoked and its pending replacement inserted, or neither.
      await db.batch([
        db.prepare("UPDATE tenant_case_grants SET state = 'revoked', version = version + 1, revoked_operation_id = ?, revoked_at = ? WHERE client_id = ? AND grant_id = ? AND version = ? AND state = 'active'")
          .bind(replacement.createdOperationId, at, clientId, grantId, expectedVersion),
        db.prepare(`INSERT INTO tenant_case_grants (${INSERT_COLUMNS}) SELECT ${PLACEHOLDERS} WHERE EXISTS (SELECT 1 FROM tenant_case_grants WHERE client_id = ? AND grant_id = ? AND revoked_operation_id = ?)`)
          .bind(...values(replacement), clientId, grantId, replacement.createdOperationId),
      ]).catch(() => undefined); // a lost race or a taken slot rolls the batch back; the read below decides
      const stored = await get(clientId, replacement.grantId);
      return stored && stored.createdOperationId === replacement.createdOperationId && stored.supersedes === grantId ? stored : null;
    },
    async activate({ clientId, grantId, version }) {
      await db.prepare("UPDATE tenant_case_grants SET state = 'active', version = version + 1 WHERE client_id = ? AND grant_id = ? AND version = ? AND state = 'pending'").bind(clientId, grantId, version).run();
      const stored = await get(clientId, grantId);
      return stored?.state === 'active' && stored.version === version + 1 ? stored : null;
    },
    async revoke({ clientId, grantId, expectedVersion, operationId, at }) {
      await db.prepare("UPDATE tenant_case_grants SET state = 'revoked', version = version + 1, revoked_operation_id = ?, revoked_at = ? WHERE client_id = ? AND grant_id = ? AND version = ? AND state IN ('pending', 'active')")
        .bind(operationId, at, clientId, grantId, expectedVersion).run();
      const stored = await get(clientId, grantId);
      return stored?.state === 'revoked' && stored.revokedOperationId === operationId ? stored : null;
    },
  };
}
