import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import { readFileSync } from 'node:fs';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { requestReadAudit, provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../native-runtime-config/harness.ts';
import { hostedWorld, countedD1, measure } from '../budget/harness.ts';
import { MIGRATION } from '../provisioning/world.ts';

/** Real hosted composition and app-cookie authentication; only D1, R2 and session KV are local doubles. */
async function world() {
 const w = await hostedWorld();
 w.db.sqlite.exec(MIGRATION);
 w.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
 w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
 w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
 const file = planNativeRuntimeConfig(exampleInput()).clients.find(c => c.clientId === 'client-a')!;
 const db = countedD1(w.db, w.counters), pending: Promise<void>[] = [];
 const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: w.bucket,
  CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} } });
 const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
 const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
 const session = await mintAppSession(config, { sid: 'synthetic-wire-session', subject: 'wire-reader', name: 'Synthetic Reader' });
 const cookie = `clearcase_session=${await signAppSession(config, session)}`;
 w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('wire-grant','client-a','case','case-a',?,'wire-reader','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
 const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
 await provisionAuditBinding({ db, config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [issuer, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
 const compose = async (path: string) => {
  const request = new Request(origin + path, { headers: { cookie } });
  const ready = await hostedServices(request, env, { waitUntil: p => pending.push(p) });
  expect(ready.ready).toBe(true); expect(ready.services.identity.kind).toBe('verified');
  return ready.services;
 };
 const assetId = w.db.rows<{ asset_id: string }>("SELECT asset_id FROM rs_case_original WHERE case_id='case-a' LIMIT 1")[0]!.asset_id;
 const asset = { kind: 'original' as const, caseId: id('case', 'case-a'), assetId };
 const get = async () => (await compose(`/cases/case-a/originals/${assetId}`)).assets.get({ asset, request: { method: 'GET', range: null, ifRange: null } });
 return { ...w, pending, compose, asset, get, async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}

it('M2: an original GET persists its asset id before releasing bytes through hostedServices', async () => {
 const w = await world();
 try {
  const response = await w.get(); expect(response.status).toBe(200);
  expect(w.db.rows('SELECT action, object_kind, object_id FROM native_audit_events WHERE action=?', 'asset.read-original'))
   .toEqual([{ action: 'asset.read-original', object_kind: 'asset', object_id: w.asset.assetId }]);
 } finally { await w.cleanup(); }
});
it('M2: a failed asset audit still prevents non-fast original delivery', async () => {
 const w = await world();
 try {
  w.db.sqlite.exec("CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON native_audit_events WHEN NEW.action='asset.read-original' BEGIN SELECT RAISE(ABORT, 'synthetic delivery audit failure'); END;");
  const response = await w.get(); expect(response.status).toBe(503); expect(await response.text()).toBe('');
 } finally { await w.cleanup(); }
});
it('L2/M2: real hostedServices page wiring collapses two authorizations to one lookup and read row', async () => {
 const w = await world();
 try {
  const result = await measure(w.counters, async () => {
   const s = await w.compose('/cases/case-a/v/placeholder/overview');
   await s.store.publication({ caseId: w.caseId });
   await s.store.publication({ caseId: w.caseId });
  });
  expect(result.thrown).toBeUndefined(); expect(result.counts).toEqual({ d1: 1, clerk: 0, r2: 0, otherFetch: 0 });
  await Promise.all(w.pending);
  expect(w.db.rows('SELECT action FROM native_audit_events')).toEqual([{ action: 'case.read' }]);
 } finally { await w.cleanup(); }
});
it('M2: a version asset byte route does not enter page authorization or deferred audit mode', async () => {
 const w = await world();
 try {
  const s = await w.compose('/cases/case-a/v/placeholder/assets/synthetic-preview');
  expect(s.caseRead).toBeUndefined();
 } finally { await w.cleanup(); }
});
