// Sprint ticket 06: what one overview page view (the version layout's load and the overview's, as SvelteKit runs them
// for one request) costs over the published synthetic version: no R2 read once the shards are in the Cache API, one on a
// cold overview shard, and at most three D1 queries: the grant, the publication row (authorized like a case read) and the
// notes summary. The harness identity makes no grant query (harness.ts), so its budget here is two.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as overviewLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/overview/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/** The grant query production's identity makes and the harness identity does not. */
const GRANT_QUERY = 1;
const WARM: Budget = { clerk: 0, d1: 3 - GRANT_QUERY, r2: 0 };
const COLD_OVERVIEW: Budget = { clerk: 0, d1: 3 - GRANT_QUERY, r2: 1 };

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests. */
function client() {
  const c = counters(), cache = memoryShardCache();
  const l = locals(dep, { db: countedD1(dep.db, c), r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
  // Per request the routes share one `locals`; this world's reader is built once, so its storage gate has passed (09b moves the gate out of the request).
  const view = async () => {
    const event = { locals: { ...l }, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/') } as never;
    return Promise.all([layoutLoad(event), overviewLoad(event)]);
  };
  return { c, cache, view };
}

describe('06 overview page view budget', () => {
  test('warm: 0 R2 reads, at most 3 D1 queries with the grant; cold overview shard: 1 R2 read', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('06 overview (warm)', WARM, w.c, w.view);
    expect(warm.thrown).toBeUndefined();
    for (const k of [...w.cache.entries.keys()]) if (k.endsWith('/overview.json')) w.cache.entries.delete(k);
    const cold = await expectWithinBudget('06 overview (cold overview shard)', COLD_OVERVIEW, w.c, w.view);
    expect(cold.counts.r2).toBe(1);
    console.log(`06 overview budget: first visit ${JSON.stringify(first.counts)} (storage gate and both shards), warm ${JSON.stringify(warm.counts)}, cold overview ${JSON.stringify(cold.counts)}`);
  });
});
