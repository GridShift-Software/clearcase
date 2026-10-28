import { afterAll, beforeAll, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { datasetView } from '../../../src/lib/views/hosted/payloads.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, measure } from './harness.ts';

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());
for (const id of ['elements_tab', 'legality_tab', 'contracts_tab', 'quantum_tab', 'invoice_ledger_tab', 'prescription_tab'] as const) {
  test(`${id}: at most one D1 and one R2 cold; zero R2 warm`, async () => {
    const c = counters(), cache = memoryShardCache();
    const l = locals(dep, { db: countedD1(dep.db, c), r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
    const load = datasetView(id, () => false);
    const view = () => {
      const event = { locals: { ...l }, params: { caseId: CASE_ID, version: b.built.record.resultsVersion } };
      return Promise.all([layoutLoad(event as never), load(event)]);
    };
    // Warm the reader's storage integrity gate; this isn't a per-page query.
    await measure(c, view);
    for (const key of cache.entries.keys()) if (key.endsWith(`/view/${id}.json`)) cache.entries.delete(key);
    const cold = await measure(c, view);
    expect(cold.thrown).toBeUndefined();
    expect(cold.counts.d1).toBeLessThanOrEqual(1);
    expect(cold.counts.r2).toBe(1);
    const warm = await measure(c, view);
    expect(warm.thrown).toBeUndefined();
    expect(warm.counts.d1).toBeLessThanOrEqual(1);
    expect(warm.counts.r2).toBe(0);
    console.log(`${id}: cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}`);
  });
}
