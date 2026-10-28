import { readFileSync } from 'node:fs';
import { requestReadAudit, requestAuditSink } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: { CLEARCASE_ASSET_TICKET_KEY: 'synthetic-test-key' } }));
import { builtCase, published, locals, CASE_ID, type BuiltCase, realAuthority, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, measure, assertWithinBudget } from './harness.ts';
import { MIGRATION, MANIFEST } from '../provisioning/world.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { requestCaseLookup } from '../../../src/lib/tenancy/request-case.ts';
import { bindPageReads } from '../../../src/lib/tenancy/page-reads.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { load as layout } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as overview } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/overview/+page.server.ts';
import { load as view } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/[category]/[view]/+page.server.ts';
import { load as originalView } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.server.ts';
import { originalWorld } from '../../hosted-smoke/originals/08-world.ts';
import { id, resultsVersion as rv } from '../../../src/lib/server/runtime/ids.ts';
import type { Identity, RequestServices } from '../../../src/lib/server/runtime/contracts.ts';
import { shard } from '../../../src/lib/views/hosted/payloads.server.ts';
import { readCase, requireCurrent } from '../../../src/lib/views/hosted/case.server.ts';

const { clientIssuer: _, ...tuple } = MANIFEST.clients[0]!;
const resource = resolveExactDeployment(validateClientManifest(MANIFEST), tuple);
const config = auditConfig({ clientId: resource.clientId, trustedIssuers: [resource.clientIssuer, resource.staffIssuer], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 1000, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });
const pendingAudits: Promise<void>[] = [];
let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
 b = await builtCase(); dep = await published(b);
 dep.db.sqlite.exec(MIGRATION);
 dep.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
 await provisionAuditBinding({ db: dep.db, config, now: () => new Date('2001-01-01T00:00:00Z') });
 dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('page-grant','client-a','case',?,?,'reader','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, CASE_ID, resource.clientIssuer);
}, 120_000);
afterAll(async () => { await Promise.all(pendingAudits); await b?.cleanup(); });

function request(subject = 'reader', clientId = 'client-a', caseId = CASE_ID, cache = memoryShardCache(), c = counters()) {
 const db = countedD1(dep.db, c);
 const now = () => new Date('2001-01-01T00:00:00Z');
 const requester = { kind: 'verified' as const, principal: { issuer: resource.clientIssuer, subject, kind: 'client' as const }, sessionId: id('session', 'synthetic-session') };
 const audit = requestAuditSink({ db, config, requester, now });
 const pending: Promise<void>[] = [];
 const schedule = requestReadAudit({ db, config, waitUntil: p => { pending.push(p); pendingAudits.push(p); } });
 const l = locals(dep, { db, cache, audit, bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c) });
 const lookup = requestCaseLookup(db, resource);
 const authorizer = createCaseAuthorizer({ deployment: resource, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment: resource }), lookup,
  audit: { append: async e => { schedule(e); return { eventId: e.eventId }; } }, readAudit: schedule, now });
 let authorizations = 0;
 const identity: Identity = { kind: 'verified', principal: { issuer: resource.clientIssuer, subject, kind: 'client' }, sessionId: id('session', 'synthetic-session'), clientId: id('client', clientId), checkRevocation: async () => {},
  authorize: async a => {
   authorizations++;
   if (clientId !== resource.clientId) { // the provider's normal client binding
    const { contractError } = await import('../../../src/lib/server/runtime/errors.ts'); throw contractError('wrong-client');
   }
   await authorizer.authorizeCase({ ...a, principal: identity.principal!, sessionId: identity.sessionId! });
  } };
 l.identity = identity;
 bindPageReads(l, lookup);
 const event = { locals: l, params: { caseId, version: b.built.record.resultsVersion, category: 'analysis', view: 'matter' }, url: new URL('https://a.example.invalid/') } as never;
 return { c, l, event, lookup, pending, authorizations: () => authorizations, warmShell: () => l.shards.read({ caseId: id('case', CASE_ID), resultsVersion: rv(b.built.record.resultsVersion), name: 'shell.json', bytes: b.files.get('shell.json')!.byteLength }) };
}

it('09b overview: one grant/case/publication/notes query, zero Clerk; warm shell and overview', async () => {
 const w = request();
 await w.warmShell(); // the first visit is measured separately below
 const result = await measure(w.c, () => Promise.all([layout(w.event), overview(w.event)]));
 expect(result.thrown).toBeUndefined();
 expect(result.counts.d1).toBe(1); assertWithinBudget('09b overview', result.counts, { d1: 1, clerk: 0, r2: 1 });
 const info = await readCase(w.l, CASE_ID);
 await requireCurrent(w.l, info.info, b.built.record.resultsVersion);
 await w.l.store.publication({ caseId: id('case', CASE_ID) });
 expect(w.c.d1).toBe(1);
 console.log('09b overview', result.counts);
});

it('09b category/view and repeated notes authorization share the lookup', async () => {
 const w = request();
 await w.warmShell();
 const result = await measure(w.c, () => Promise.all([layout(w.event), view(w.event)]));
 expect(result.thrown).toBeUndefined(); expect(result.counts.d1).toBe(1);
 assertWithinBudget('09b category/view', result.counts, { d1: 1, clerk: 0, r2: 1 });
});

it.each(['no-grant', 'wrong-case', 'revoked', 'foreign-database'])('09b refuses %s in one query before shard reads', async reason => {
 if (reason === 'revoked') dep.db.exec("UPDATE tenant_case_grants SET state='revoked', revoked_at='2001-01-01T00:00:00.000Z', revoked_operation_id='revoke' WHERE grant_id='page-grant'");
 const w = request(reason === 'no-grant' ? 'ungranted' : 'reader', 'client-a', reason === 'wrong-case' ? 'other-case' : CASE_ID);
 if (reason === 'foreign-database') dep.db.exec("UPDATE rs_storage_identity SET client_id='client-c'");
 try {
  const result = await measure(w.c, () => layout(w.event));
  expect(result.thrown).toMatchObject({ status: 404 });
  expect(result.counts.d1).toBe(1); expect(result.counts.r2).toBe(0);
 } finally {
  if (reason === 'revoked') dep.db.exec("UPDATE tenant_case_grants SET state='active', revoked_at=NULL, revoked_operation_id=NULL WHERE grant_id='page-grant'");
  if (reason === 'foreign-database') dep.db.exec("UPDATE rs_storage_identity SET client_id='client-a'");
 }
});

it('09b has no authority cache across requests after revocation', async () => {
 await request().l.store.publication({ caseId: id('case', CASE_ID) });
 dep.db.exec("UPDATE tenant_case_grants SET state='revoked', revoked_at='2001-01-01T00:00:00.000Z', revoked_operation_id='revoke' WHERE grant_id='page-grant'");
 try { await expect(request().l.store.publication({ caseId: id('case', CASE_ID) })).rejects.toMatchObject({ code: 'forbidden' }); }
 finally { dep.db.exec("UPDATE tenant_case_grants SET state='active', revoked_at=NULL, revoked_operation_id=NULL WHERE grant_id='page-grant'"); }
});

it('09b original view includes original metadata in the one grant query', async () => {
 const w = await originalWorld();
 // 08's world owns its grants and original; add the shard schema and user-work tables this snapshot reads.
 const { readFileSync } = await import('node:fs');
 w.dep.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
 w.dep.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
 const { MIGRATION: workMigration, bind } = await import('../user-work/world.ts');
 w.dep.db.sqlite.exec(workMigration); bind(w.dep.db.sqlite);
 const db = countedD1(w.dep.db, w.c), lookup = requestCaseLookup(db, resource, 'asset-a');
 const identity = w.identity;
 if (identity.kind !== 'verified') throw new Error('fixture');
 w.dep.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
 await provisionAuditBinding({ db: w.dep.db, config, now: () => new Date('2026-10-28T00:00:00Z') });
 const pending: Promise<void>[] = [];
 const schedule = requestReadAudit({ db, config, waitUntil: p => { pending.push(p); pendingAudits.push(p); } });
 const auth = createCaseAuthorizer({ deployment: resource, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment: resource }), lookup, readAudit: schedule, audit: { append: async e => { schedule(e); return { eventId: e.eventId }; } }, now: () => new Date('2026-10-28T00:00:00Z') });
 const l = w.locals({ ...identity, authorize: a => auth.authorizeCase({ ...a, principal: identity.principal, sessionId: identity.sessionId }) }) as RequestServices;
 bindPageReads(l, lookup);
 const result = await measure(w.c, () => originalView({ locals: l, params: { caseId: 'case-a', assetId: 'asset-a' }, url: new URL('https://example.invalid/') } as never));
 expect(result.thrown).toBeUndefined(); expect(result.value?.view.state).toBe('available');
 expect(result.counts.d1).toBe(1); assertWithinBudget('09b original view', result.counts, { d1: 1, clerk: 0, r2: 1 });
 await Promise.all(pending);
 expect(w.c.d1).toBe(2);
 process.stdout.write(`09b original foreground ${JSON.stringify(result.counts)}, including deferred audit ${JSON.stringify(w.c.snapshot())}\n`);
});

it('09b notes summary preserves the existing case and analysis note counts', async () => {
 const legacy = locals(dep);
 const caseId = id('case', CASE_ID), resultsVersion = rv(b.built.record.resultsVersion);
 await legacy.userWork.addNote({ caseId, target: { kind: 'case' }, body: 'Synthetic case note', expected: { kind: 'absent' }, operationId: 'page-note-case' });
 await legacy.userWork.addNote({ caseId, target: { kind: 'analysis', resultsVersion, section: 'overview' }, body: 'Synthetic analysis note', expected: { kind: 'absent' }, operationId: 'page-note-analysis' });
 const expected = await legacy.userWork.summary({ caseId, resultsVersion });
 const w = request();
 const result = await measure(w.c, () => w.l.userWork.summary({ caseId, resultsVersion }));
 expect(result.thrown).toBeUndefined(); expect(result.value).toEqual(expected); expect(result.counts.d1).toBe(1);
});

it('09b expired authority never mints an original capability', async () => {
 dep.db.exec("UPDATE tenant_case_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE grant_id='page-grant'");
 try { await expect(request().l.store.publication({ caseId: id('case', CASE_ID) })).rejects.toMatchObject({ code: 'forbidden' }); }
 finally { dep.db.exec("UPDATE tenant_case_grants SET expires_at=NULL WHERE grant_id='page-grant'"); }
});

it('09b principal grant lookup uses the existing index without a grant-table scan', async () => {
 let plan: unknown[] = [];
 const db = { ...dep.db, prepare(sql: string) {
  const statement = dep.db.prepare(sql);
  return { ...statement, bind(...values: (string | number | null)[]) {
   plan = dep.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
   return statement.bind(...values);
  } };
 }, batch: dep.db.batch.bind(dep.db) };
 await requestCaseLookup(db, resource)({ caseId: id('case', CASE_ID), principal: { issuer: resource.clientIssuer, subject: 'reader', kind: 'client' } });
 const details = JSON.stringify(plan);
 expect(details).toContain('SEARCH g USING INDEX tenant_case_grants_principal');
 expect(details).not.toMatch(/SCAN g\b/);
 console.log('09b grant query plan', details);
});

it('09b a grant belonging to another client never grants this client case access', async () => {
 dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('foreign-grant','client-c','case',?,?,'foreign-reader','client','viewer','content','active',1,'foreign-seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, CASE_ID, resource.clientIssuer);
 const w = request('foreign-reader');
 const result = await measure(w.c, () => layout(w.event));
 expect(result.thrown).toMatchObject({ status: 404 }); expect(result.counts.d1).toBe(1); expect(result.counts.r2).toBe(0);
});

it('09b exposes the fully cold two-shard overview cost separately from the one-R2 warm-shell budget', async () => {
 const w = request();
 const result = await measure(w.c, () => Promise.all([layout(w.event), overview(w.event)]));
 expect(result.thrown).toBeUndefined(); expect(result.counts).toEqual({ d1: 1, clerk: 0, r2: 2, otherFetch: 0 });
});

it('09b measures 06 baseline and fresh production authority/audit page visits, including background work', async () => {
 const baseline = await published(b), before = counters(), beforeCache = memoryShardCache(), db = countedD1(baseline.db, before);
 const oldVisit = async () => {
  const authority = await realAuthority(baseline, db);
  const l = locals(baseline, { identity: authority.identity, audit: authority.audit, db, cache: beforeCache, r2: countedR2(baseline.r2, before), bucket: countedR2(baseline.bucket, before) });
  const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/') } as never;
  return Promise.all([layout(event), overview(event)]);
 };
 try {
  expect((await measure(before, oldVisit)).thrown).toBeUndefined();
  const oldWarm = await measure(before, oldVisit);
  expect(oldWarm.thrown).toBeUndefined();
  expect(oldWarm.counts).toEqual({ d1: 14, clerk: 0, r2: 1, otherFetch: 0 });
  const c = counters(), cache = memoryShardCache();
  const visit = async () => {
   const w = request('reader', 'client-a', CASE_ID, cache, c); // a fresh service graph per visit; only the Cache API is shared
   const page = await measure(c, () => Promise.all([layout(w.event), overview(w.event)]));
   expect(page.thrown).toBeUndefined(); expect(w.authorizations()).toBe(2);
   await Promise.all(w.pending);
   expect(w.pending).toHaveLength(1);
   const withAudit = c.snapshot();
   expect(page.counts.d1).toBe(1); expect(withAudit.d1).toBe(2);
   return { foreground: page.counts, includingAudit: withAudit };
  };
  const first = await visit(), warm = await visit();
  expect(warm.foreground.r2).toBe(0);
  for (const key of [...cache.entries.keys()]) if (key.endsWith('/overview.json')) cache.entries.delete(key);
  const coldOverview = await visit(); expect(coldOverview.foreground.r2).toBe(1);
  cache.entries.clear();
  const fullyCold = await visit(); expect(fullyCold.foreground.r2).toBe(2);
  process.stdout.write(`09b fresh production authorizer/audit: ${JSON.stringify({ beforeWarm: oldWarm.counts, first, warm, coldOverview, fullyCold })}\n`);
 } finally { baseline.db.sqlite.close(); }
});

it('09b joined publication refuses unadmitted shard names before cache or R2 access', async () => {
 const w = request();
 const result = await measure(w.c, () => shard(w.l, { caseId: CASE_ID, version: b.built.record.resultsVersion }, 'view/not-admitted.json'));
 expect(result.thrown).toMatchObject({ status: 404 });
 expect(result.counts).toEqual({ d1: 1, clerk: 0, r2: 0, otherFetch: 0 });
 const p = await w.l.store.publication({ caseId: id('case', CASE_ID) });
 expect(p?.shards?.['overview.json']).toBe(b.files.get('overview.json')!.byteLength);
});
