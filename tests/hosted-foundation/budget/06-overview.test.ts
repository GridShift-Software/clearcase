// Sprint ticket 06: what one overview page view (the version layout's load and the overview's, as SvelteKit runs them
// for one request) costs over the published synthetic version. Every request builds its services afresh, as
// hosted/services.ts does, with the production case authorizer (grant query, case directory, audit append) and the
// production request audit sink over the same counted D1; only the Cache API is shared between requests. Clerk is not
// in the loop: its session checks are 09a's.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as overviewLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/overview/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/** The ticket's acceptance budget for a page view. */
const WARM: Budget = { clerk: 0, d1: 3, r2: 0 };
const COLD_OVERVIEW: Budget = { clerk: 0, d1: 3, r2: 1 };

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests, fresh services per request. */
function client() {
  const c = counters(), cache = memoryShardCache(), db = countedD1(dep.db, c);
  let authorizations = 0;
  const view = async () => {
    const authority = await realAuthority(dep, db);
    const l = locals(dep, { identity: authority.identity, audit: authority.audit, db, r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
    const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/') } as never;
    try { return await Promise.all([layoutLoad(event), overviewLoad(event)]); } finally { authorizations = authority.counted.authorizations; }
  };
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, view, evict, authorizations: () => authorizations };
}

describe('06 overview page view budget', () => {
  test('warm shards and a cold overview shard stay within the ticket budget', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('06 overview (warm)', WARM, w.c, w.view);
    expect(warm.thrown).toBeUndefined();
    w.evict('/overview.json');
    const cold = await expectWithinBudget('06 overview (cold overview shard)', COLD_OVERVIEW, w.c, w.view);
    expect(cold.thrown).toBeUndefined();
    console.log(`06 overview budget: first ${JSON.stringify(first.counts)}, warm ${JSON.stringify(warm.counts)}, cold overview ${JSON.stringify(cold.counts)}, authorize calls ${w.authorizations()}`);
  });
});
