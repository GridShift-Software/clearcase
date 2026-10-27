import type { CaseId, Principal, SessionId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { LAYOUT } from '../storage/cloud/gate.ts';
import { belongs } from './authorizer.ts';
import { GRANT_ROLES, enables } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// The operate capability as it stands now, observed without an audit event. The audited decision stays the case
// authorizer's (authorizeCapability), made once when an operator request is admitted. An observation reads the same
// rows again: an active, unexpired grant of a role that enables operate, held by this exact principal on this case, in a
// database bound to this client that holds the case. It is one SQL condition, so a caller can either read it on its own
// or put it in a guard statement of its own D1 write batch, where it holds atomically with the write.
// An expiry counts only in its canonical form (the strftime round trip); D1 refuses a LIKE or GLOB pattern over 50 bytes.

export type OperateSubject = { principal: Principal; sessionId: SessionId; caseId: CaseId };
export interface OperateCondition { sql: string; values: (string | number | null)[] }
export interface OperateObservation {
  /** Resolves while the principal holds operate on the existing case; rejects with forbidden, wrong-client or identity-unavailable. */
  observe(a: OperateSubject): Promise<void>;
  /** The same check as one SQL boolean expression over this client's database, for a guard statement or a column. */
  condition(a: OperateSubject): OperateCondition;
}

const OPERATORS = GRANT_ROLES.filter((r) => enables(r, 'operate'));
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function d1OperateObservation(o: { db: D1; deployment: ClientResourceIdentity; now(): Date }): OperateObservation {
  const { db, deployment } = o;
  function condition(a: OperateSubject): OperateCondition {
    // A principal of another issuer, or a malformed case id, holds nothing: the condition is false, never an error.
    if (!a?.principal || !belongs(deployment, a.principal) || typeof a.caseId !== 'string' || !CASE_ID.test(a.caseId)) return { sql: '0', values: [] };
    return {
      sql: `(EXISTS (SELECT 1 FROM rs_storage_identity i JOIN rs_case c ON c.case_id = ? WHERE i.singleton = 1 AND i.client_id = ? AND i.layout = ?)
        AND EXISTS (SELECT 1 FROM tenant_case_grants g WHERE g.client_id = ? AND g.scope = 'case' AND g.case_id = ? AND g.issuer = ? AND g.subject = ?
          AND g.principal_kind = ? AND g.state = 'active' AND g.role IN (${OPERATORS.map(() => '?').join(', ')})
          AND (g.expires_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', g.expires_at) = g.expires_at
            AND julianday(g.expires_at) > julianday(?)))))`,
      values: [a.caseId, deployment.clientId, LAYOUT, deployment.clientId, a.caseId, a.principal.issuer, a.principal.subject, a.principal.kind, ...OPERATORS, o.now().toISOString()],
    };
  }
  return {
    condition,
    async observe(a) {
      if (!a?.principal || !a.sessionId) throw contractError('unauthenticated');
      if (!belongs(deployment, a.principal)) throw contractError('wrong-client');
      const c = condition(a);
      const row = await db.prepare(`SELECT ${c.sql} AS ok`).bind(...c.values).first<{ ok: number }>().catch(() => { throw contractError('identity-unavailable', true); });
      if (row?.ok !== 1) throw contractError('forbidden');
    },
  };
}
