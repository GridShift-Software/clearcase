// Sprint ticket 15: what one search page view (the version layout's load and the search view's) costs over the published
// synthetic version: with the shell shard warm, no R2 read once the index is in the Cache API and one on a cold index, and
// one D1 query (the publication row, authorized like a case read). The harness identity makes no grant query. Parsing a
// v5-sized index takes under 100 ms.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as searchLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { indexRow, type SearchIndex } from '../../../src/lib/views/evidence/search.ts';
import { listRow, resetOrd } from '../../evidence/rows.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

const WARM: Budget = { clerk: 0, d1: 1, r2: 0 };
const COLD_INDEX: Budget = { clerk: 0, d1: 1, r2: 1 };
const V5_DOCUMENTS = 1689;

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

function client() {
  const c = counters(), cache = memoryShardCache();
  const l = locals(dep, { db: countedD1(dep.db, c), r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
  const view = async () => {
    const event = { locals: { ...l }, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/?q=BK-0042') } as never;
    return Promise.all([layoutLoad(event), searchLoad(event)]);
  };
  return { c, cache, view };
}

describe('15 search page view budget', () => {
  test('warm: 0 R2 reads and 1 D1 query; cold index: 1 R2 read', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('15 search (warm)', WARM, w.c, w.view);
    expect(warm.thrown).toBeUndefined();
    for (const k of [...w.cache.entries.keys()]) if (k.endsWith('/search/index.json')) w.cache.entries.delete(k);
    const cold = await expectWithinBudget('15 search (cold index)', COLD_INDEX, w.c, w.view);
    expect(cold.counts.r2).toBe(1);
    console.log(`15 search budget: first visit ${JSON.stringify(first.counts)} (storage gate and both shards), warm ${JSON.stringify(warm.counts)}, cold index ${JSON.stringify(cold.counts)}`);
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
