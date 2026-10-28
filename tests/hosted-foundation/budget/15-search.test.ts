// Sprint ticket 15: what one search page view (the version layout's load and the search view's, as SvelteKit runs them
// for one request) costs over the published synthetic version. Every request builds its services afresh, as
// hosted/services.ts does, with the production case authorizer (grant query, case directory, audit append) and the
// production request audit sink over the same counted D1; only the Cache API is shared between requests. Clerk is not
// in the loop: its session checks are 09a's. Parsing a v5-sized index takes under 100 ms.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as searchLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { indexRow, type SearchIndex } from '../../../src/lib/views/evidence/search.ts';
import { listRow, resetOrd } from '../../evidence/rows.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/**
 * The measured baseline, as a ceiling: not the ticket's acceptance budget (0 Clerk, at most 1 D1 and 1 R2 cold, 0 warm),
 * which this path does not meet yet. Per warm search page view, 7 D1 and 1 R2 (06's overview is 14 and 1; this view has
 * no notes summary, so one case authorization instead of two):
 *   - the storage gate, once per fresh service graph: 1 D1 (rs_storage_identity) and the 1 R2 (identity/client.json);
 *   - one case authorization, the publication read's: 5 D1 (grants, case directory, audit binding, audit insert, audit readback);
 *   - the publication row with the admitted shard names: 1 D1.
 * Ticket 09b's single per-request grant lookup removes the per-request gate and the audit readback. The index itself is
 * 15's own: none warm, one R2 read cold.
 */
const BASELINE: Budget = { clerk: 0, d1: 7, r2: 1 };
const AUTHORIZATIONS = 1;
const V5_DOCUMENTS = 1689;

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
    const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/?q=BK-0042') } as never;
    try { return await Promise.all([layoutLoad(event), searchLoad(event)]); } finally { authorizations = authority.counted.authorizations; }
  };
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, view, evict, authorizations: () => authorizations };
}

describe('15 search page view budget', () => {
  test('warm shards: no shard read and the measured baseline; a cold index, and a wholly cold visit, are each one R2 read more per shard', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('15 search (warm)', BASELINE, w.c, w.view);
    expect([warm.thrown, w.authorizations()]).toEqual([undefined, AUTHORIZATIONS]);
    w.evict('/search/index.json');
    const cold = await expectWithinBudget('15 search (cold index)', { ...BASELINE, r2: BASELINE.r2! + 1 }, w.c, w.view);
    expect([cold.thrown, cold.counts.r2 - warm.counts.r2, cold.counts.d1]).toEqual([undefined, 1, warm.counts.d1]);
    w.evict('.json');
    const wholly = await expectWithinBudget('15 search (shell shard and index cold)', { ...BASELINE, r2: BASELINE.r2! + 2 }, w.c, w.view);
    expect([wholly.thrown, wholly.counts.r2 - warm.counts.r2, wholly.counts.d1]).toEqual([undefined, 2, warm.counts.d1]);
    console.log(`15 search budget, fresh services per request, production authorizer and audit: first ${JSON.stringify(first.counts)}, warm ${JSON.stringify(warm.counts)}, cold index ${JSON.stringify(cold.counts)}, shell and index cold ${JSON.stringify(wholly.counts)}; ${w.authorizations()} authorize calls per page view`);
  });

  test('the index of a v5-sized synthetic version parses in under 100 ms', () => {
    resetOrd();
    const rows = Array.from({ length: V5_DOCUMENTS }, (_, i) => indexRow({
      ...listRow(`SY-${String(i).padStart(5, '0')}`, { subject: `Synthetic correspondence number ${i} about the premises`, filename: `SY-${i} synthetic correspondence.pdf`, sender: `sender${i % 40}@example.invalid`, to: `recipient${i % 25}@example.invalid`, excerpt: 'Invented excerpt text. '.repeat(40) }),
      cc: `copy${i % 10}@example.invalid`,
    }));
    const text = JSON.stringify({ rows } satisfies SearchIndex);
    expect(text.length).toBeGreaterThan(1_000_000);
    const t0 = performance.now();
    const parsed = JSON.parse(text) as SearchIndex;
    const ms = performance.now() - t0;
    console.log(`15 search index: ${V5_DOCUMENTS} rows, ${(text.length / 1e6).toFixed(2)} MB, parse ${ms.toFixed(1)} ms`);
    expect(parsed.rows).toHaveLength(V5_DOCUMENTS);
    expect(ms).toBeLessThan(100);
  });
});
