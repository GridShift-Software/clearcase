// Sprint ticket 11: what the hosted chronology costs over the published synthetic version (two list pages). One page view
// is the version layout's load and the chronology's, as SvelteKit runs them for one request; `list.json?page=2` is one
// request of its own. Every request builds its services afresh as hosted/services.ts does for a page request since 09b:
// the production case authorizer over 09b's single per-request lookup (grant, case, publication and admitted shards in
// one D1 query), the read audit deferred to after the response, and the request audit sink, all over the same counted
// D1; only the Cache API is shared between requests. Clerk is not in the loop: its session checks are 09a's.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as chronologyLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/+page.server.ts';
import { GET as listGet } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/list.json/+server.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { requestAuditSink, requestReadAudit } from '../../../src/lib/audit/facades.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { bindPageReads } from '../../../src/lib/tenancy/page-reads.ts';
import { requestCaseLookup } from '../../../src/lib/tenancy/request-case.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { MANIFEST, MIGRATION } from '../provisioning/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, type Counters } from './harness.ts';

/**
 * The ticket's budget: a page view at most 1 D1 and 1 R2 for a cold shard of its own; `list.json?page=2` no D1 beyond the
 * authorization (09b's one lookup), 1 R2 cold and none warm. Measured foreground, warm: 1 D1 and no R2 for each. The read
 * audit adds one deferred D1 write after the response. Not met: the first view after publication finds the version's
 * shell (the layout's, 06's) and both of this page's shards (facets and page 1, read side by side) cold, 3 R2.
 */
const PAGE: Budget = { clerk: 0, d1: 1, r2: 0 };
const LIST: Budget = { clerk: 0, d1: 1, r2: 0 };
const plus = (b: Budget, r2: number): Budget => ({ ...b, r2: b.r2! + r2 });

const { clientIssuer: _, ...tuple } = MANIFEST.clients[0]!;
const resource = resolveExactDeployment(validateClientManifest(MANIFEST), tuple);
const config = auditConfig({ clientId: resource.clientId, trustedIssuers: [resource.clientIssuer, resource.staffIssuer], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 1000, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });
const now = () => new Date('2001-01-01T00:00:00Z');

let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
  b = await builtCase(); dep = await published(b);
  dep.db.sqlite.exec(MIGRATION);
  dep.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  await provisionAuditBinding({ db: dep.db, config, now });
  dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('chrono-grant','client-a','case',?,?,'reader','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, CASE_ID, resource.clientIssuer);
}, 120_000);
afterAll(() => b?.cleanup());

/** One request's services, as hosted/services.ts builds them for a page request; `cache` is the only thing shared. */
function request(c: Counters, cache: ReturnType<typeof memoryShardCache>, url: string) {
  const db = countedD1(dep.db, c), pending: Promise<void>[] = [];
  const principal = { issuer: resource.clientIssuer, subject: 'reader', kind: 'client' as const }, sessionId = id('session', 'synthetic-session');
  const schedule = requestReadAudit({ db, config, waitUntil: (p) => { pending.push(p); } });
  const l = locals(dep, { db, cache, audit: requestAuditSink({ db, config, requester: { kind: 'verified', principal, sessionId }, now }), bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c) });
  const lookup = requestCaseLookup(db, resource);
  const authorizer = createCaseAuthorizer({ deployment: resource, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment: resource }), lookup,
    audit: { append: async (e) => { schedule(e); return { eventId: e.eventId }; } }, readAudit: schedule, now });
  let authorizations = 0;
  const identity: Identity = { kind: 'verified', principal, sessionId, clientId: id('client', resource.clientId), checkRevocation: async () => {},
    authorize: async (a) => { authorizations++; await authorizer.authorizeCase({ ...a, principal, sessionId }); } };
  l.identity = identity;
  bindPageReads(l, lookup);
  const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL(url), request: new Request(url) } as never;
  return { event, settled: () => Promise.all(pending), authorizations: () => authorizations };
}

function client() {
  const c = counters(), cache = memoryShardCache();
  const at = `https://client-a.example.invalid/cases/${CASE_ID}/v/${encodeURIComponent(b.built.record.resultsVersion)}/chronology`;
  /** One request, measured in the foreground; then its deferred read audit, counted on its own. */
  const visit = async <T>(label: string, budget: Budget, url: string, run: (e: never) => Promise<T>) => {
    const r = request(c, cache, url);
    const fg = await expectWithinBudget(label, budget, c, () => run(r.event));
    expect(fg.thrown).toBeUndefined();
    const before = c.d1; await r.settled();
    return { ...fg.counts, deferredD1: c.d1 - before, authorizations: r.authorizations() };
  };
  const view = (label: string, budget: Budget) => visit(label, budget, at, (e) => Promise.all([layoutLoad(e), chronologyLoad(e)]));
  const list = (label: string, budget: Budget, q: string) => visit(label, budget, `${at}/list.json${q}`, async (e) => {
    const r = (await listGet(e)) as Response; if (!r.ok) throw new Error(String(r.status)); return r.text();
  });
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { view, list, evict };
}

describe('11 chronology budget', () => {
  test('page view: warm 1 D1 and no R2; one cold shard of its own is 1 R2; the fully cold first view is 3 R2', async () => {
    const w = client();
    const cold = await w.view('11 chronology page (fully cold)', plus(PAGE, 3));
    const warm = await w.view('11 chronology page (warm)', PAGE);
    w.evict('/list/page-1.json');
    const page1 = await w.view('11 chronology page (cold page 1)', plus(PAGE, 1));
    w.evict('/list/facets.json');
    const facets = await w.view('11 chronology page (cold facets)', plus(PAGE, 1));
    expect([cold.r2, warm.r2, page1.r2, facets.r2]).toEqual([3, 0, 1, 1]);
    expect([cold.d1, warm.d1, page1.d1, facets.d1]).toEqual([1, 1, 1, 1]);
    console.log(`11 chronology page budget, 09b's request lookup, fresh services per request: fully cold ${JSON.stringify(cold)}, warm ${JSON.stringify(warm)}, cold page 1 ${JSON.stringify(page1)}, cold facets ${JSON.stringify(facets)}`);
  });

  test('list.json?page=2: the one lookup in D1; 1 R2 read cold, none warm; ?all=1 warm reads no shard', async () => {
    const w = client();
    await w.view('11 chronology page (fully cold, before the list)', plus(PAGE, 3)); // the page's own request warms page 1
    const cold = await w.list('11 list.json?page=2 (cold)', plus(LIST, 1), '?page=2');
    const warm = await w.list('11 list.json?page=2 (warm)', LIST, '?page=2');
    const all = await w.list('11 list.json?all=1 (warm)', LIST, '?all=1');
    expect([cold.r2, warm.r2, all.r2, cold.d1, warm.d1, all.d1]).toEqual([1, 0, 0, 1, 1, 1]);
    console.log(`11 list budget, 09b's request lookup: page 2 cold ${JSON.stringify(cold)}, warm ${JSON.stringify(warm)}; ?all=1 warm ${JSON.stringify(all)}`);
  });
});
