// Sprint ticket 06: `cli.ts grant` provisions one viewer grant through the provisioning-only producer and its audit port,
// and a second run replays the first. Synthetic SQLite behind D1's shape with the real storage, tenancy and audit schemas.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { grantViewer } from '../../../scripts/publish/grant.ts';
import { deployment } from '../../hosted-foundation/storage/fixture.ts';
import { MIGRATION as USER_WORK } from '../../hosted-foundation/user-work/world.ts';
import { CASE_ID } from './world.ts';

const read = (p: string) => readFileSync(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');
const SCHEMA = ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql', 'audit/migrations/0001_native_audit.sql'].map(read).join('\n');
const CLIENT = { clientId: 'client-a', hostname: 'a.clearcase.example.test', worker: 'clearcase-client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'clearcase-client-a', r2Bucket: 'clearcase-client-a' };
const ISSUER = 'https://client-a.example.test';
const NATIVE = JSON.stringify({
  schema: 'clearcase.native-runtime/1', deployment: CLIENT,
  manifest: { staffIssuer: 'https://staff.example.test', clients: [{ ...CLIENT, clientIssuer: ISSUER }] },
  auditLimits: { maxEventBytes: 4096, maxRows: 1000, maxReadRows: 1000, maxDenialRows: 100, maxDenialsPerActor: 8, maxPageRows: 50, maxPagesPerRequest: 5 },
});
const now = () => new Date('2001-01-01T00:00:00.000Z');

function world() {
  const dep = deployment('client-a', [CASE_ID]);
  dep.db.sqlite.exec(SCHEMA);
  dep.db.sqlite.exec(USER_WORK);
  return dep.db;
}

describe('06 grant', () => {
  test('binds user work, grants viewer on the case once, audited; a second run replays it', async () => {
    const db = world();
    const first = await grantViewer({ db, nativeConfig: NATIVE, caseId: CASE_ID, subject: 'user_viewer', now });
    expect(first).toMatchObject({ kind: 'applied', repeated: false });
    const again = await grantViewer({ db, nativeConfig: NATIVE, caseId: CASE_ID, subject: 'user_viewer', now });
    expect(again).toEqual({ ...first, repeated: true });
    expect(db.rows('SELECT case_id, issuer, subject, principal_kind, role, state, expires_at FROM tenant_case_grants')).toEqual([
      { case_id: CASE_ID, issuer: ISSUER, subject: 'user_viewer', principal_kind: 'client', role: 'viewer', state: 'active', expires_at: null },
    ]);
    expect(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM native_audit_events WHERE event_id LIKE 'grant-op:%'")[0]!.n).toBe(1);
    expect(db.rows('SELECT client_id FROM uw_binding')).toEqual([{ client_id: 'client-a' }]);
  });

  test('refuses a case the deployment does not have, and grants nothing to anyone else', async () => {
    const db = world();
    expect(await grantViewer({ db, nativeConfig: NATIVE, caseId: 'no-such-case', subject: 'user_viewer', now })).toEqual({ kind: 'refused', reason: 'invalid: unknown case' });
    await grantViewer({ db, nativeConfig: NATIVE, caseId: CASE_ID, subject: 'user_viewer', now });
    expect(db.rows("SELECT subject FROM tenant_case_grants WHERE subject <> 'user_viewer'")).toEqual([]);
  });
});
