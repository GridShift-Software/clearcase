import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { provisionIntakeGrant } from '../../../scripts/intake/provision.ts';
import { deployment } from '../../hosted-foundation/storage/fixture.ts';
import { createUploadProvisioning } from '../../../src/lib/tenancy/upload-provisioning.ts';
import { nativeDeployment } from '../../../scripts/publish/grant.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';

const CLIENT = { clientId: 'client-a', hostname: 'a.clearcase.example.test', worker: 'clearcase-client-a',
  d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'clearcase-client-a', r2Bucket: 'clearcase-client-a' };
const NATIVE = JSON.stringify({ schema: 'clearcase.native-runtime/1', deployment: CLIENT,
  manifest: { staffIssuer: 'https://staff.example.test', clients: [{ ...CLIENT, clientIssuer: 'https://client-a.example.test' }] },
  auditLimits: { maxEventBytes: 4096, maxRows: 1000, maxReadRows: 1000, maxDenialRows: 100, maxDenialsPerActor: 8, maxPageRows: 50, maxPagesPerRequest: 5 },
});
const now = () => new Date('2001-01-01T00:00:00.000Z');
function world() {
  const { db } = deployment('client-a', ['case-a']);
  for (const file of ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql',
    'tenancy/migrations/0003_tenant_upload_grants.sql', 'audit/migrations/0001_native_audit.sql']) {
    db.sqlite.exec(readFileSync(new URL(`../../../src/lib/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}

describe('19 upload grant provisioning', () => {
  it('uses the audited producer idempotently and grants no case-read role', async () => {
    const db = world(), args = { db, nativeConfig: NATIVE, caseId: 'case-a', subject: 'synthetic-user', now };
    const first = await provisionIntakeGrant(args);
    expect(first).toMatchObject({ kind: 'applied', repeated: false, grant: { state: 'active' } });
    expect(await provisionIntakeGrant(args)).toEqual({ ...first, repeated: true });
    expect(db.rows('SELECT state FROM tenant_upload_grant_operations')).toEqual([{ state: 'audited' }]);
    expect(db.rows('SELECT * FROM tenant_case_grants')).toEqual([]);
    expect(db.rows('SELECT event_id FROM native_audit_events')).toHaveLength(1);
    if (first.kind !== 'applied') throw new Error('grant missing');
    const native = nativeDeployment(NATIVE);
    const producer = createUploadProvisioning({ db, deployment: native.deployment, now,
      cases: d1CaseDirectory({ db, deployment: native.deployment }), audit: provisioningAuditPort({ db, config: native.audit, now }) });
    expect(await producer.revoke({ operator: 'intake-cli', operationId: 'synthetic-revoke', grantId: first.grant.grantId, expectedVersion: first.grant.version })).toMatchObject({ kind: 'applied' });
    await provisionIntakeGrant(args);
    expect(db.rows('SELECT state FROM tenant_upload_grants')).toEqual([{ state: 'revoked' }]);
  });

  it('refuses unknown cases without creating a grant', async () => {
    const db = world();
    expect(await provisionIntakeGrant({ db, nativeConfig: NATIVE, caseId: 'other-case', subject: 'synthetic-user', now })).toMatchObject({ kind: 'invalid' });
    expect(db.rows('SELECT * FROM tenant_upload_grants')).toEqual([]);
  });
});
