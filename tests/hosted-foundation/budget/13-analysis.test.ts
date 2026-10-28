import { requestReadAudit } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { createCaseAuthorizer, d1GrantRepository } from '../../../src/lib/tenancy/index.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { requestCaseLookup } from '../../../src/lib/tenancy/request-case.ts';
import { bindPageReads } from '../../../src/lib/tenancy/page-reads.ts';
import { ids } from '../storage/fixture.ts';
import type { Budget } from './budget.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, expectWithinBudget } from './harness.ts';
let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); await realAuthority(dep); }, 120_000);
const pending: Promise<void>[] = [];
const flushAudit = () => Promise.all(pending.splice(0));
afterAll(async () => { await flushAudit(); await b?.cleanup(); });
import { load as matter } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/matter/+page.server.ts';
import { load as timeline } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/timeline/+page.server.ts';
import { load as contradictions_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/contradictions_tab/+page.server.ts';
import { load as risk_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/risk_matrix_tab/+page.server.ts';
import { load as vdm_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/vdm_matrix_tab/+page.server.ts';
import { load as witness_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/witness_tab/+page.server.ts';
import { load as people } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/people/+page.server.ts';
import { load as entity_ledger_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/entity_ledger_tab/+page.server.ts';
import { load as conflict_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/conflict_tab/+page.server.ts';
const routes = [
  ['analysis/matter', matter],
  ['analysis/timeline', timeline],
  ['analysis/contradictions_tab', contradictions_tab],
  ['analysis/risk_matrix_tab', risk_matrix_tab],
  ['analysis/vdm_matrix_tab', vdm_matrix_tab],
  ['analysis/witness_tab', witness_tab],
  ['evidence/people', people],
  ['evidence/entity_ledger_tab', entity_ledger_tab],
  ['litigation/conflict_tab', conflict_tab],] as const;

/** Foreground measured ceilings with 09b's one-lookup path, fresh services and deferred production audit.
 * Ticket target: 0 Clerk, <=1 D1, <=1 cold R2, 0 warm R2. Warm/cold-view meet it;
 * the first visit still needs 2 R2 reads (shell + view), so the single-cold-read target is not met there.
 * The deferred audit adds one D1 after the response; asserted separately, never hidden or counted in the next visit.
 */
const FIRST: Budget = { clerk: 0, d1: 1, r2: 2 };
const WARM: Budget = { clerk: 0, d1: 1, r2: 0 };
const COLD: Budget = { clerk: 0, d1: 1, r2: 1 };
const deployment = { clientId: ids.clientA, hostname: 'client-a.example.invalid', worker: 'client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'client-a',
  r2Bucket: 'client-a', clientIssuer: 'https://clerk.client-a.example.invalid', staffIssuer: 'https://clerk.staff.example.invalid' };
const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer],
  limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 1000, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });

test.each(routes)('%s measures first, warm and cold visits with fresh one-lookup services', async (route, load) => {
  const c = counters(), cache = memoryShardCache();
  const view = async () => {
    const db = countedD1(dep.db, c);
    const authority = await realAuthority(dep, db);
    const lookup = requestCaseLookup(db, deployment);
    const schedule = requestReadAudit({ db, config, waitUntil: work => { pending.push(work); } });
    const authorizer = createCaseAuthorizer({ deployment, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment }), lookup,
      audit: { append: async event => { schedule(event); return { eventId: event.eventId }; } }, readAudit: schedule,
      now: () => new Date('2001-01-01T00:00:00Z') });
    const identity = authority.identity;
    identity.authorize = scope => authorizer.authorizeCase({ ...scope, principal: identity.principal!, sessionId: identity.sessionId! });
    const l = locals(dep, { db, identity, audit: authority.audit, bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c), cache });
    bindPageReads(l, lookup);
    const event = { locals: l, params: { caseId: CASE_ID, version: b.synth.resultsVersion } } as never;
    return Promise.all([layoutLoad(event), load(event)]);
  };
  const first = await expectWithinBudget(route + ' first', FIRST, c, view);
  expect(first.thrown).toBeUndefined();
  expect(first.counts.clerk).toBe(0);
  await flushAudit();
  expect(c.d1).toBe(first.counts.d1 + 1);
  const warm = await expectWithinBudget(route + ' warm', WARM, c, view);
  expect(warm.thrown).toBeUndefined();
  expect(warm.counts.clerk).toBe(0);
  await flushAudit();
  expect(c.d1).toBe(warm.counts.d1 + 1);
  for (const key of cache.entries.keys()) if (key.endsWith(`/view/${route.split('/').at(-1)}.json`)) cache.entries.delete(key);
  const cold = await expectWithinBudget(route + ' cold', COLD, c, view);
  expect(cold.thrown).toBeUndefined();
  expect(cold.counts.clerk).toBe(0);
  await flushAudit();
  expect(c.d1).toBe(cold.counts.d1 + 1);
  dep.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2001-01-01T00:00:00Z' WHERE grant_id = 'g-viewer'");
  try {
    const denied = await expectWithinBudget(route + ' revoked', WARM, c, view);
    expect(denied.thrown).toBeDefined();
    expect(denied.counts).toMatchObject(WARM);
    await flushAudit();
  } finally { dep.db.exec("UPDATE tenant_case_grants SET state = 'active', revoked_at = NULL WHERE grant_id = 'g-viewer'"); }
  process.stdout.write(`${route} foreground ${JSON.stringify({ first: first.counts, warm: warm.counts, cold: cold.counts })}; deferred audit +1 D1 per visit\n`);
});
