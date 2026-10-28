// `grant`: the offline owned seed of docs/acceptance/hosting/case-grant-provisioning.md. It binds the client's audit log
// and user-work database (both once, both idempotent: an unbound user-work database refuses every notes read), then
// grants one principal of the deployment's client issuer `viewer` on a case, through the provisioning-only producer and
// its audit port, over the same D1 and exact deployment the Worker authorizes with. The operation id is derived from the
// case and subject, so a second run replays the first and changes nothing.
import { auditConfig } from '../../src/lib/audit/config.ts';
import { provisioningAuditPort } from '../../src/lib/audit/provisioning.ts';
import { provisionAuditBinding } from '../../src/lib/audit/trusted.ts';
import type { CaseId } from '../../src/lib/server/runtime/contracts.ts';
import type { D1 } from '../../src/lib/server/runtime/hosted/bindings.ts';
import { d1CaseDirectory } from '../../src/lib/tenancy/case-directory.ts';
import { createCaseGrantProvisioning } from '../../src/lib/tenancy/case-grant-provisioning.ts';
import { d1GrantRepository } from '../../src/lib/tenancy/d1-grants.ts';
import { resolveExactDeployment, validateClientManifest } from '../../src/lib/tenancy/manifest.ts';
import { provisionD1UserWork } from '../../src/lib/user-work/hosted/provision.ts';

export const GRANT_OPERATOR = 'publish-cli';

/** The deployment, issuers and audit limits of a wrangler configuration's CLEARCASE_NATIVE_CONFIG. */
export function nativeDeployment(nativeConfig: string) {
  const s = JSON.parse(nativeConfig) as { schema?: unknown; manifest?: unknown; deployment?: unknown; auditLimits?: unknown };
  if (s.schema !== 'clearcase.native-runtime/1') throw new Error('CLEARCASE_NATIVE_CONFIG is not clearcase.native-runtime/1');
  const deployment = resolveExactDeployment(validateClientManifest(s.manifest), s.deployment as Parameters<typeof resolveExactDeployment>[1]);
  const audit = auditConfig({ clientId: deployment.clientId, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer], limits: s.auditLimits });
  return { deployment, audit };
}

export type GrantOutcome = { kind: 'applied'; grantId: string; repeated: boolean } | { kind: 'refused'; reason: string };

export async function grantViewer(a: { db: D1; nativeConfig: string; caseId: string; subject: string; now?: () => Date }): Promise<GrantOutcome> {
  const now = a.now ?? (() => new Date());
  const { deployment, audit: config } = nativeDeployment(a.nativeConfig);
  await provisionAuditBinding({ db: a.db, config, now });
  await provisionD1UserWork({ db: a.db, clientId: deployment.clientId, now });
  const provisioning = createCaseGrantProvisioning({
    deployment, grants: d1GrantRepository(a.db), cases: d1CaseDirectory({ db: a.db, deployment }), audit: provisioningAuditPort({ db: a.db, config, now }), now,
  });
  const r = await provisioning.grantCase({
    operator: GRANT_OPERATOR, operationId: `seed-viewer:${a.caseId}:${a.subject}`.slice(0, 119),
    target: { issuer: deployment.clientIssuer, subject: a.subject, kind: 'client' }, caseId: a.caseId as CaseId, role: 'viewer', expiresAt: null,
  });
  if (r.kind === 'applied') return { kind: 'applied', grantId: r.grant.grantId, repeated: r.repeated };
  return { kind: 'refused', reason: 'reason' in r ? `${r.kind}: ${r.reason}` : r.kind };
}
