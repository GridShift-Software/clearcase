import { VIEWS } from '../../../src/lib/components/view-registry.ts';
import { hostedStatus } from '../../../src/lib/views/hosted/availability.ts';
import { readFileSync } from 'node:fs';
import { requestReadAudit, requestAuditSink } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: { CLEARCASE_ASSET_TICKET_KEY: 'synthetic-test-key' } }));
// Every registry view is ported now, so the generic placeholder route has no real `soon` view left. Report one ported
// view as `soon` here, so the budget of that route (still served to any view a later registry adds) stays measured.
vi.mock('../../../src/lib/views/hosted/availability.ts', async importOriginal => {
 const actual = await importOriginal<typeof import('../../../src/lib/views/hosted/availability.ts')>();
 return { ...actual, hostedStatus: (viewId: string) => (viewId === 'hoa_diff_tab' ? 'soon' : actual.hostedStatus(viewId)) };
});
import { builtCase, published, locals, CASE_ID, type BuiltCase, realAuthority, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, measure, assertWithinBudget } from './harness.ts';
import { MIGRATION, MANIFEST } from '../provisioning/world.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { requestPage } from '../../../src/lib/server/runtime/hosted/services.ts';
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
import { id, sha256, resultsVersion as rv } from '../../../src/lib/server/runtime/ids.ts';
import type { Identity, NoteTarget, RequestServices } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { load as document } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as search } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/+page.server.ts';
import { load as chronology } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/+page.server.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { shard } from '../../../src/lib/views/hosted/payloads.server.ts';
import { readCase, requireCurrent } from '../../../src/lib/views/hosted/case.server.ts';

const { clientIssuer: _, ...tuple } = MANIFEST.clients[0]!;
const resource = resolveExactDeployment(validateClientManifest(MANIFEST), tuple);
const config = auditConfig({ clientId: resource.clientId, trustedIssuers: [resource.clientIssuer, resource.staffIssuer], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 1000, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });
const pendingAudits: Promise<void>[] = [];
let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
 b = await builtCase({ duplicateBulkOriginals: true }); dep = await published(b);
 dep.db.sqlite.exec(MIGRATION);
 dep.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
 await provisionAuditBinding({ db: dep.db, config, now: () => new Date('2001-01-01T00:00:00Z') });
 dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('page-grant','client-a','case',?,?,'reader','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, CASE_ID, resource.clientIssuer);
}, 120_000);
afterAll(async () => { await Promise.all(pendingAudits); await b?.cleanup(); });

// SQLite has no D1 per-value response cap. Enforce it where a D1 response crosses into the adapter, without inspecting SQL.
function boundedResponses(db: D1, payloads: unknown[]): D1 {
 const inspect = (rows: unknown[]) => {
  payloads.push(rows);
  for (const row of rows) if (row && typeof row === 'object')
   for (const cell of Object.values(row)) if (typeof cell === 'string' && Buffer.byteLength(cell) > 2_000_000)
    throw new Error('D1 response cell exceeds 2 MB');
 };
 const wrap = (s: D1Statement): D1Statement => ({
  bind: (...values) => wrap(s.bind(...values)),
  async all<T>() { const result = await s.all<T>(); inspect(result.results); return result; },
  async first<T>() { const result = await s.first<T>(); inspect(result === null ? [] : [result]); return result; },
  run: () => s.run(),
 });
 return { prepare: sql => wrap(db.prepare(sql)), batch: statements => db.batch(statements) };
}

function request(subject = 'reader', clientId = 'client-a', caseId = CASE_ID, cache = memoryShardCache(), c = counters(), payloads?: unknown[], profile: 'case' | 'overview' = 'case') {
 const db = countedD1(payloads ? boundedResponses(dep.db, payloads) : dep.db, c);
 const now = () => new Date('2001-01-01T00:00:00Z');
 const requester = { kind: 'verified' as const, principal: { issuer: resource.clientIssuer, subject, kind: 'client' as const }, sessionId: id('session', 'synthetic-session') };
 const audit = requestAuditSink({ db, config, requester, now });
 const pending: Promise<void>[] = [];
 const schedule = requestReadAudit({ db, config, waitUntil: p => { pending.push(p); pendingAudits.push(p); } });
 const l = locals(dep, { db, cache, audit, bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c) });
 const lookup = requestCaseLookup(db, resource, null, profile);
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
 // Exercise the generic placeholder route even after a ticket ports its former example view.
 const placeholder = VIEWS.find(v => hostedStatus(v.id) === 'soon' && /^\/[^/]+\/[^/]+$/.test(v.route));
 if (!placeholder) throw new Error('The generic route budget fixture needs an unported registry view');
 const [, category, viewId] = placeholder.route.split('/');
 const event = { locals: l, params: { caseId, version: b.built.record.resultsVersion, category, view: viewId }, url: new URL('https://a.example.invalid/') } as never;
 return { c, l, event, lookup, pending, authorizations: () => authorizations, warmShell: () => l.shards.read({ caseId: id('case', CASE_ID), resultsVersion: rv(b.built.record.resultsVersion), name: 'shell.json', bytes: b.files.get('shell.json')!.byteLength }) };
}

function overviewRequest(...args: Parameters<typeof request>) {
 args[6] = 'overview';
 return request(...args);
}

// 17a: the overview also reads the deadlines and unbilled-time registers, one `readViewWork` each: the one lookup is
// still the only grant/case/publication/notes query, and the two register reads are the 2 D1 queries that follow it.
it('09b overview: one grant/case/publication/notes query, zero Clerk; warm shell and overview', async () => {
 const w = overviewRequest();
 await w.warmShell(); // the first visit is measured separately below
 const result = await measure(w.c, () => Promise.all([layout(w.event), overview(w.event)]));
 expect(result.thrown).toBeUndefined();
 expect(result.counts.d1).toBe(3); assertWithinBudget('09b overview', result.counts, { d1: 3, clerk: 0, r2: 1 });
 const info = await readCase(w.l, CASE_ID);
 await requireCurrent(w.l, info.info, b.built.record.resultsVersion);
 await w.l.store.publication({ caseId: id('case', CASE_ID) });
 expect(w.c.d1).toBe(3);
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
 const identity = locals(dep).identity;
 if (identity.kind !== 'verified') throw new Error('fixture');
 identity.principal = { issuer: resource.clientIssuer, subject: 'synthetic-note-seed', kind: 'client' };
 const legacy = locals(dep, { db: dep.db, identity, audit: requestAuditSink({ db: dep.db, config,
  requester: { kind: 'verified', principal: identity.principal!, sessionId: identity.sessionId! }, now: () => new Date('2001-01-01T00:00:00Z') }) });
 const caseId = id('case', CASE_ID), resultsVersion = rv(b.built.record.resultsVersion);
 await legacy.userWork.addNote({ caseId, target: { kind: 'case' }, body: 'Synthetic case note', expected: { kind: 'absent' }, operationId: 'page-note-case' });
 await legacy.userWork.addNote({ caseId, target: { kind: 'analysis', resultsVersion, section: 'overview' }, body: 'Synthetic analysis note', expected: { kind: 'absent' }, operationId: 'page-note-analysis' });
 const expectedFull = await legacy.userWork.summary({ caseId, resultsVersion });
 const full = request();
 expect(await full.l.userWork.summary({ caseId, resultsVersion })).toEqual(expectedFull);
 const { detached: _text, ...expected } = expectedFull;
 const w = overviewRequest();
 const result = await measure(w.c, () => w.l.overviewNoteSummary!({ caseId, resultsVersion }));
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
 expect(details).not.toMatch(/uw_note|uw_register_row|rs_document/);
 console.log('09b grant query plan', details);
});

it('09b a grant belonging to another client never grants this client case access', async () => {
 dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('foreign-grant','client-c','case',?,?,'foreign-reader','client','viewer','content','active',1,'foreign-seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, CASE_ID, resource.clientIssuer);
 const w = request('foreign-reader');
 const result = await measure(w.c, () => layout(w.event));
 expect(result.thrown).toMatchObject({ status: 404 }); expect(result.counts.d1).toBe(1); expect(result.counts.r2).toBe(0);
});

it('09b exposes the fully cold two-shard overview cost separately from the one-R2 warm-shell budget', async () => {
 const w = overviewRequest();
 const result = await measure(w.c, () => Promise.all([layout(w.event), overview(w.event)]));
 expect(result.thrown).toBeUndefined(); expect(result.counts).toEqual({ d1: 3, clerk: 0, r2: 2, otherFetch: 0 });
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
  expect(oldWarm.counts).toEqual({ d1: 25, clerk: 0, r2: 1, otherFetch: 0 }); // 13 before 17a; each register read authorizes on this path
  const c = counters(), cache = memoryShardCache();
  const visit = async () => {
   const w = overviewRequest('reader', 'client-a', CASE_ID, cache, c); // a fresh service graph per visit; only the Cache API is shared
   const page = await measure(c, () => Promise.all([layout(w.event), overview(w.event)]));
   expect(page.thrown).toBeUndefined(); expect(w.authorizations()).toBe(2);
   await Promise.all(w.pending);
   expect(w.pending).toHaveLength(1);
   const withAudit = c.snapshot();
   expect(page.counts.d1).toBe(3); expect(withAudit.d1).toBe(4); // 17a: + the two register reads
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

it('large valid case notes cannot break document, search, chronology or overview reads', async () => {
 const body = 'Synthetic note body never needed by these pages. '.repeat(400);
 expect(Buffer.byteLength(body)).toBeLessThan(20_000);
 const before = await locals(dep).userWork.summary({ caseId: id('case', CASE_ID), resultsVersion: rv(b.built.record.resultsVersion) });
 const count = 120;
 expect(Buffer.byteLength(body) * count).toBeGreaterThan(2_000_000);
 const insert = dep.db.sqlite.prepare(`INSERT INTO uw_note (case_id, note_id, target_kind, target_json, body, body_sha256, created_at, version)
  VALUES (?, ?, 'case', '{"kind":"case"}', ?, ?, '2200-01-01T00:00:00Z', 'v-large')`);
 try {
  for (let i = 0; i < count; i++) insert.run(CASE_ID, `large-${i}`, body, sha256Hex(body));
  const oldTarget = { kind: 'document', anchor: { caseId: CASE_ID, resultsVersion: `sha256:${'a'.repeat(64)}`, refAtCreation: 'OLD', sha256: 'f'.repeat(64) } };
  dep.db.exec("UPDATE uw_note SET target_kind='document', target_json=?, anchor_results_version=?, anchor_ref='OLD', anchor_sha256=? WHERE note_id='large-0'", JSON.stringify(oldTarget), oldTarget.anchor.resultsVersion, oldTarget.anchor.sha256);
  const [{ fingerprint }] = dep.db.rows<{ fingerprint: string }>("SELECT json_extract(state_json, '$.original.sha256') AS fingerprint FROM rs_document WHERE version_id=? AND ref='BK-0001'", b.built.record.resultsVersion);
  for (const [load, route] of [[document, 'doc/BK-0000'], [search, 'evidence/search'], [chronology, 'chronology'], [overview, 'overview']] as const) for (const data of [false, true]) {
   const payloads: unknown[] = [];
   const w = request('reader', 'client-a', CASE_ID, memoryShardCache(), counters(), payloads, requestPage('GET', `/cases/${CASE_ID}/v/${b.built.record.resultsVersion}/${route}${data ? '/__data.json' : ''}`).profile);
   const event = { locals: w.l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ref: 'BK-0000' }, url: new URL('https://a.example.invalid/') } as never;
   const result = await measure(w.c, () => Promise.all([layout(event), load(event)]));
   expect(result.thrown).toBeUndefined();
   expect(JSON.stringify(payloads)).not.toContain(body);
   expect(JSON.stringify(payloads[0])).not.toContain(fingerprint);
   expect(JSON.stringify(payloads[0])).not.toContain('fingerprints_json');
   if (load === overview) expect(result.value?.[1]).toMatchObject({ notes: { total: count + before.total, here: count - 1 + before.here, missing: before.missing + 1, unanchored: before.unanchored, pageNotes: 0, detached: [] } });
  }
 } finally { dep.db.exec("DELETE FROM uw_note WHERE note_id LIKE 'large-%'"); }
});

it('overview lookup does not repeat the publication shard list for each noted document', async () => {
 const caseId = id('case', CASE_ID), version = rv(b.built.record.resultsVersion);
 const refs = dep.db.rows<{ ref: string }>('SELECT ref FROM rs_document WHERE version_id=? ORDER BY ref LIMIT 200', version);
 expect(refs).toHaveLength(200);
 const before = await locals(dep).userWork.summary({ caseId, resultsVersion: version });
 const body = 'Synthetic document note';
 try {
  dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at)
   SELECT 'fanout-grant',client_id,scope,case_id,issuer,subject,principal_kind,'operator','operator',state,version,'fanout-grant-op',request,created_by_issuer,created_by_subject,created_at FROM tenant_case_grants WHERE grant_id='page-grant'`);
  for (const [i, { ref }] of refs.entries()) {
   const target = { kind: 'document', anchor: { caseId, resultsVersion: version, refAtCreation: ref, sha256: null } };
   dep.db.exec(`INSERT INTO uw_note (case_id,note_id,target_kind,anchor_results_version,anchor_ref,target_json,body,body_sha256,created_at,version)
    VALUES (?,?,'document',?,?,?,?,?,'2200-01-01T00:00:00Z','v-fanout')`, caseId, `fanout-${i}`, version, ref, JSON.stringify(target), body, sha256Hex(body));
  }
  for (const data of [false, true]) {
   const profile = requestPage('GET', `/cases/${caseId}/v/${version}/overview${data ? '/__data.json' : ''}`).profile;
   const payloads: unknown[] = [], w = request('reader', 'client-a', CASE_ID, memoryShardCache(), counters(), payloads, profile);
   const result = await measure(w.c, () => w.l.overviewNoteSummary!({ caseId, resultsVersion: version }));
   expect(result.thrown).toBeUndefined(); expect(result.counts.d1).toBe(1);
   expect(result.value).toMatchObject({ total: before.total + refs.length, here: before.here + refs.length });
   expect(result.value?.byRef).toEqual(refs.map(({ ref }) => ({ ref, n: 1, status: 'here' })));
   const rows = payloads.flat() as Record<string, unknown>[];
   const manifests = rows.filter(r => typeof r.admitted_json === 'string');
   // At most one case snapshot per live grant, independent of the number of noted refs.
   expect(manifests).toHaveLength(2);
   expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(1_000_000);
  }
 } finally {
  dep.db.exec("DELETE FROM uw_note WHERE note_id LIKE 'fanout-%'");
  dep.db.exec("DELETE FROM tenant_case_grants WHERE grant_id='fanout-grant'");
 }
});

it('overview counts match the full summary for every attachment status, ref ordering and stored page-note count', async () => {
 const caseId = id('case', CASE_ID), resultsVersion = rv(b.built.record.resultsVersion), oldVersion = rv(`sha256:${'b'.repeat(64)}`);
 const fingerprints = dep.db.rows<{ ref: string; sha: string }>("SELECT ref, json_extract(state_json, '$.original.sha256') AS sha FROM rs_document WHERE version_id=? AND ref IN ('BK-0000', 'BK-0001', 'BK-0002') ORDER BY ref", resultsVersion);
 const ambiguousSha = fingerprints[0]!.sha, exactSha = fingerprints[2]!.sha;
 expect(fingerprints[1]!.sha).toBe(ambiguousSha); expect(exactSha).not.toBe(ambiguousSha);
 const add = (name: string, target: NoteTarget) => {
  const body = `Synthetic parity note ${name}`;
  const anchor = target.kind === 'document' ? target.anchor : null;
  dep.db.exec(`INSERT INTO uw_note (case_id, note_id, target_kind, anchor_results_version, anchor_ref, anchor_sha256, target_json, body, body_sha256, created_at, version)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2200-01-01T00:00:00Z', 'v-parity')`, caseId, `parity-${name}`, target.kind, anchor?.resultsVersion ?? null, anchor?.refAtCreation ?? null, anchor?.sha256 ?? null, JSON.stringify(target), body, sha256Hex(body));
 };
 const documentTarget = (version: typeof resultsVersion, refAtCreation: string, sha: string | null): NoteTarget =>
  ({ kind: 'document', anchor: { caseId, resultsVersion: version, refAtCreation, sha256: sha ? sha256(sha) : null } });
 const pageInsert = dep.db.sqlite.prepare(`INSERT INTO uw_register_row (case_id, store, row_id, fields_json, fields_sha256, created_at, updated_at, version)
  VALUES (?, ?, ?, 'null', 'unreadable', '2200-01-01', '2200-01-01', 'v-parity')`);
 try {
  add('here', documentTarget(resultsVersion, 'BK-0001', null));
  add('exact', documentTarget(oldVersion, 'OLD-EXACT', exactSha));
  add('ambiguous', documentTarget(oldVersion, 'OLD-MANY', ambiguousSha));
  add('missing', documentTarget(oldVersion, 'OLD-GONE', 'f'.repeat(64)));
  add('unanchored', documentTarget(oldVersion, 'OLD-NO-HASH', null));
  add('analysis', { kind: 'analysis', resultsVersion, section: 'overview' });
  add('case', { kind: 'case' });
  // The full contract must still expose corruption in detached text; counts make no integrity claim.
  dep.db.exec("UPDATE uw_note SET body='Changed synthetic detached body' WHERE note_id='parity-analysis'");
  pageInsert.run(caseId, 'original-page-notes', 'parity-page');
  pageInsert.run('other-case', 'original-page-notes', 'parity-other');
  pageInsert.run(caseId, 'deadlines', 'parity-register');
  const legacy = locals(dep), expected = await legacy.userWork.summary({ caseId, resultsVersion });
  const full = request();
  expect(await full.l.userWork.summary({ caseId, resultsVersion })).toEqual(expected);
  expect(expected.detached.find(n => n.id === 'parity-analysis')).toMatchObject({ body: 'Changed synthetic detached body', intact: false });
  const { detached: _text, ...expectedCounts } = expected;
  for (const data of [false, true]) {
   const profile = requestPage('GET', `/cases/${caseId}/v/${resultsVersion}/overview${data ? '/__data.json' : ''}`).profile;
   const payloads: unknown[] = [], w = request('reader', 'client-a', CASE_ID, memoryShardCache(), counters(), payloads, profile);
   const result = await measure(w.c, () => w.l.overviewNoteSummary!({ caseId, resultsVersion }));
   expect(result.thrown).toBeUndefined(); expect(result.value).toEqual(expectedCounts); expect(result.counts.d1).toBe(1);
   expect(result.value?.byRef).toEqual([{ ref: 'BK-0001', n: 2, status: 'here' }, { ref: 'BK-0002', n: 1, status: 'exact' }, { ref: 'BK-0000', n: 1, status: 'ambiguous' }]);
   expect(result.value).toMatchObject({ exact: 1, ambiguous: 1, missing: 1, pageNotes: 1 });
   expect(JSON.stringify(payloads)).not.toContain('Changed synthetic detached body');
  }
 } finally {
  dep.db.exec("DELETE FROM uw_note WHERE note_id LIKE 'parity-%'");
  dep.db.exec("DELETE FROM uw_register_row WHERE row_id LIKE 'parity-%'");
 }
});

it.each(['missing-work-binding', 'wrong-work-binding', 'stale-version', 'withdrawn', 'no-grant', 'wrong-case', 'wrong-client'])('overview projection refuses %s without a second lookup', async reason => {
 const binding = dep.db.rows<{ client_id: string; schema_version: number; bound_at: string }>('SELECT * FROM uw_binding')[0]!;
 const triggers = dep.db.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('uw_binding_no_delete', 'uw_binding_client_fixed')");
 if (reason.endsWith('work-binding')) dep.db.sqlite.exec('DROP TRIGGER uw_binding_no_delete; DROP TRIGGER uw_binding_client_fixed');
 const caseId = id('case', reason === 'wrong-case' ? 'other-case' : CASE_ID), version = rv(b.built.record.resultsVersion);
 if (reason === 'missing-work-binding') dep.db.exec('DELETE FROM uw_binding');
 if (reason === 'wrong-work-binding') dep.db.exec("UPDATE uw_binding SET client_id='client-c'");
 if (reason === 'withdrawn') dep.db.exec("UPDATE rs_publication SET state='withdrawn' WHERE case_id=?", CASE_ID);
 try {
  const w = overviewRequest(reason === 'no-grant' ? 'ungranted' : 'reader', reason === 'wrong-client' ? 'client-c' : 'client-a');
  const result = await measure(w.c, () => w.l.overviewNoteSummary!({ caseId, resultsVersion: reason === 'stale-version' ? rv(`sha256:${'e'.repeat(64)}`) : version }));
  expect(result.thrown).toMatchObject({ code: reason.endsWith('work-binding') ? 'storage-unavailable' : reason === 'wrong-client' ? 'wrong-client' : 'forbidden' });
  expect(result.counts.d1).toBe(reason === 'wrong-client' ? 0 : 1); expect(result.counts.r2).toBe(0);
 } finally {
  if (reason.endsWith('work-binding')) {
   dep.db.exec('DELETE FROM uw_binding');
   dep.db.exec('INSERT INTO uw_binding(singleton,client_id,schema_version,bound_at) VALUES (1,?,?,?)', binding.client_id, binding.schema_version, binding.bound_at);
   for (const trigger of triggers) dep.db.sqlite.exec(trigger.sql);
  }
  if (reason === 'withdrawn') dep.db.exec("UPDATE rs_publication SET state='published' WHERE case_id=?", CASE_ID);
 }
});
