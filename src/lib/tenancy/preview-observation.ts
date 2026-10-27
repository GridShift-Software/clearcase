import { GRANT_ROLES, permits } from './grants.ts';

// SQL fragments are source-owned, never request input. The readiness fence adds its content-slot
// restriction; the material reader intentionally observes any role granting read-preview.
const PREVIEWERS = Object.freeze(GRANT_ROLES.filter((role) => permits(role, 'read-preview')));
export function previewGrantCondition(context: 'bound' | 'readiness'): string {
  const bound = context === 'bound';
  const client = bound ? '?' : 'o.client_id', caseId = bound ? '?' : 'o.case_id';
  const issuer = bound ? '?' : 'o.issuer', subject = bound ? '?' : 'o.subject';
  const kind = bound ? '?' : "'staff'", now = bound ? '?' : "'now'";
  const roles = bound ? PREVIEWERS.map(() => '?').join(', ') : "'viewer', 'editor'";
  return `EXISTS (SELECT 1 FROM tenant_case_grants g WHERE g.client_id = ${client} AND g.scope = 'case' AND g.case_id = ${caseId}
    AND g.issuer = ${issuer} AND g.subject = ${subject} AND g.principal_kind = ${kind}
    AND g.state = 'active' AND g.revoked_at IS NULL AND g.role IN (${roles})
    ${bound ? '' : "AND g.slot = 'content'"}
    AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday(${now})))`;
}

export const previewGrantRoles = PREVIEWERS;
