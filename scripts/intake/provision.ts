// Non-request provisioning only: reuse the audited upload producer unchanged.
import { provisioningAuditPort } from '../../src/lib/audit/provisioning.ts';
import { provisionAuditBinding } from '../../src/lib/audit/trusted.ts';
import { id } from '../../src/lib/server/runtime/ids.ts';
import type { D1 } from '../../src/lib/server/runtime/hosted/bindings.ts';
import { d1CaseDirectory } from '../../src/lib/tenancy/case-directory.ts';
import { bindUploadDatabase, createUploadProvisioning } from '../../src/lib/tenancy/upload-provisioning.ts';
import { nativeDeployment } from '../publish/grant.ts';

export async function provisionIntakeGrant(a: { db: D1; nativeConfig: string; caseId: string; subject: string; now?: () => Date }) {
  const { deployment, audit } = nativeDeployment(a.nativeConfig);
  const now = a.now ?? (() => new Date());
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    deployment.clientId, deployment.clientIssuer, a.caseId, a.subject,
  ])));
  const operationId = `intake-grant:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await provisionAuditBinding({ db: a.db, config: audit, now });
  await bindUploadDatabase(a.db, deployment);
  return createUploadProvisioning({ deployment, db: a.db, now,
    cases: d1CaseDirectory({ db: a.db, deployment }), audit: provisioningAuditPort({ db: a.db, config: audit, now }),
  }).grant({ operator: 'intake-cli', operationId, caseId: id('case', a.caseId),
    target: { issuer: deployment.clientIssuer, subject: a.subject, kind: 'client' }, expiresAt: null });
}
