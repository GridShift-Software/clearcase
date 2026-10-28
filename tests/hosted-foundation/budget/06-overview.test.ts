// Sprint ticket 06: what one overview page view (the version layout's load and the overview's, as SvelteKit runs them
// for one request) costs over the published synthetic version. Every request builds its services afresh, as
// hosted/services.ts does (one-lookup.ts), with the production case authorizer over 09b's single grant lookup and the
// production request audit sink, deferred; only the Cache API is shared between requests. Clerk is not in the loop:
// its session checks are 09a's.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as overviewLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/overview/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, expectWithinBudget, measure } from './harness.ts';
import { oneLookupLocals } from './one-lookup.ts';

/**
 * The measured ceilings after 09b's one-lookup path, as in 13-analysis.test.ts. Ticket target: 0 Clerk, at most 3 D1, 0 R2
 * warm; MET. Warm is 1 D1 (the one lookup holds the grant, case, publication and notes summary) and 0 R2; a cold overview shard
 * is 1 R2 and a cold shell and overview 2, one R2 read per cold shard. The deferred audit
 * insert adds one D1 after the response; it is asserted separately, never hidden or counted in the next visit.
 * Before 09b: 14 D1 and 1 R2 warm (two authorizations at 5 D1 each, the storage gate, the publication row, 2 notes D1).
 */
// 17a: the overview fills its deadlines and unbilled-time tiles from the two registers, one `readViewWork` each: 2 D1 more
// (the case lookup is shared, so neither read looks the grant up again) and 2 more authorize calls.
const BASELINE: Budget = { clerk: 0, d1: 3, r2: 0 };
const AUTHORIZATIONS = 4;

let b: BuiltCase, dep: Deployment;
const pending: Promise<void>[] = [];
const flushAudit = () => Promise.all(pending.splice(0));
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(async () => { await flushAudit(); await b?.cleanup(); });

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests, fresh services per request. */
function client() {
  const c = counters(), cache = memoryShardCache();
  let authorizations = 0;
  const view = async () => {
    const services = await oneLookupLocals(dep, c, cache, pending);
    const event = { locals: services.l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/') } as never;
    try { return await Promise.all([layoutLoad(event), overviewLoad(event)]); } finally { authorizations = services.authorizations(); }
  };
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, view, evict, authorizations: () => authorizations };
}

describe('06 overview page view budget', () => {
  test('warm shards: no shard read and the measured baseline; each cold shard is one R2 read more', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    await flushAudit();
    expect(w.c.d1).toBe(first.counts.d1 + 1);
    const warm = await expectWithinBudget('06 overview (warm)', BASELINE, w.c, w.view);
    expect([warm.thrown, w.authorizations()]).toEqual([undefined, AUTHORIZATIONS]);
    await flushAudit();
    expect(w.c.d1).toBe(warm.counts.d1 + 1);
    w.evict('/overview.json');
    const cold = await expectWithinBudget('06 overview (cold overview shard)', { ...BASELINE, r2: BASELINE.r2! + 1 }, w.c, w.view);
    expect([cold.thrown, cold.counts.r2 - warm.counts.r2, cold.counts.d1]).toEqual([undefined, 1, warm.counts.d1]);
    await flushAudit();
    expect(w.c.d1).toBe(cold.counts.d1 + 1);
    w.evict('.json');
    const wholly = await expectWithinBudget('06 overview (shell and overview shards cold)', { ...BASELINE, r2: BASELINE.r2! + 2 }, w.c, w.view);
    expect([wholly.thrown, wholly.counts.r2 - warm.counts.r2, wholly.counts.d1]).toEqual([undefined, 2, warm.counts.d1]);
    await flushAudit();
    expect(w.c.d1).toBe(wholly.counts.d1 + 1);
    console.log(`06 overview budget, fresh services per request, one-lookup authorizer and deferred audit (+1 D1 each): first ${JSON.stringify(first.counts)}, warm ${JSON.stringify(warm.counts)}, cold overview ${JSON.stringify(cold.counts)}, shell and overview cold ${JSON.stringify(wholly.counts)}; ${w.authorizations()} authorize calls per page view`);
  });
});
