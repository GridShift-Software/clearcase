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

/**
 * The measured baseline, as a ceiling: not the ticket's acceptance budget (0 Clerk, at most 3 D1, 0 R2 warm), which this
 * path does not meet yet. Per warm page view, 14 D1 and 1 R2:
 *   - the storage gate, once per fresh service graph: 1 D1 (rs_storage_identity) and the 1 R2 (identity/client.json);
 *   - two case authorizations, the publication read's and the notes summary's: 5 D1 each (grants, case directory, audit
 *     binding, audit insert, audit readback);
 *   - the publication row with the admitted shard names: 1 D1; the notes summary: 2 D1 (uw_binding, uw_note).
 * Ticket 09b's single per-request grant lookup removes the second authorization and the per-request gate; 09a owns the
 * Clerk side. Shard reads are 06's own: none warm, one per cold shard.
 */
const BASELINE: Budget = { clerk: 0, d1: 14, r2: 1 };
const AUTHORIZATIONS = 2;

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
  test('warm shards: no shard read and the measured baseline; each cold shard is one R2 read more', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('06 overview (warm)', BASELINE, w.c, w.view);
    expect([warm.thrown, w.authorizations()]).toEqual([undefined, AUTHORIZATIONS]);
    w.evict('/overview.json');
    const cold = await expectWithinBudget('06 overview (cold overview shard)', { ...BASELINE, r2: BASELINE.r2! + 1 }, w.c, w.view);
    expect([cold.thrown, cold.counts.r2 - warm.counts.r2, cold.counts.d1]).toEqual([undefined, 1, warm.counts.d1]);
    w.evict('.json');
    const wholly = await expectWithinBudget('06 overview (shell and overview shards cold)', { ...BASELINE, r2: BASELINE.r2! + 2 }, w.c, w.view);
    expect([wholly.thrown, wholly.counts.r2 - warm.counts.r2, wholly.counts.d1]).toEqual([undefined, 2, warm.counts.d1]);
    console.log(`06 overview budget, fresh services per request, production authorizer and audit: first ${JSON.stringify(first.counts)}, warm ${JSON.stringify(warm.counts)}, cold overview ${JSON.stringify(cold.counts)}, shell and overview cold ${JSON.stringify(wholly.counts)}; ${w.authorizations()} authorize calls per page view`);
  });
});
