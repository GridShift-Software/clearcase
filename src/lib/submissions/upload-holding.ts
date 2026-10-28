import type { D1 } from '../server/runtime/hosted/bindings.ts';
import type { ClientResourceIdentity } from '../tenancy/manifest.ts';
import { createUploadHolding, parseUploadGrant, UPLOAD_COLUMNS, type UploadRow } from '../tenancy/upload-capability.ts';

/** Advisory UI lookup only. The existing upload authorizer still decides every
 * mutation. Join the immutable database binding into the grant snapshot so a
 * fresh shell render adds only one D1 query, including its resource pin.
 */
export function intakeUploadHolding(o: { db: D1; deployment: ClientResourceIdentity; now: () => Date }) {
  return createUploadHolding({ deployment: o.deployment, now: o.now, uploads: {
    async heldBy({ clientId, caseId, principal }) {
      if (clientId !== o.deployment.clientId) throw new Error('foreign upload scope');
      const { results } = await o.db.prepare(`SELECT ${UPLOAD_COLUMNS}
        FROM tenant_upload_grants g
        JOIN tenant_upload_binding b ON b.singleton = 1 AND b.client_id = g.client_id AND b.d1_database_id = ?
        JOIN tenant_upload_grant_operations op ON op.client_id = g.client_id AND op.operation_id = g.created_operation_id AND op.grant_id = g.grant_id
        WHERE g.client_id = ? AND g.case_id = ? AND g.issuer = ? AND g.subject = ? AND g.principal_kind = ?
          AND g.state = 'active' AND op.operation = 'issue' AND op.state = 'audited'`)
        .bind(o.deployment.d1DatabaseId, clientId, caseId, principal.issuer, principal.subject, principal.kind).all<UploadRow>();
      return results.map((row) => parseUploadGrant(row, clientId));
    },
  } });
}
