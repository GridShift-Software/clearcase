import { afterAll, beforeAll, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';
let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());
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

test.each(routes)('%s uses one D1 and one cold shard read, zero warm R2', async (route, load) => {
  const c = counters(), cache = memoryShardCache();
  const l = locals(dep, { db: countedD1(dep.db, c), bucket: countedR2(dep.bucket, c), cache });
  const view = () => {
    const event = { locals: { ...l }, params: { caseId: CASE_ID, version: b.synth.resultsVersion } } as never;
    return Promise.all([layoutLoad(event), load(event)]);
  };
  expect((await measure(c, view)).thrown).toBeUndefined();
  const warm = await expectWithinBudget(route + ' warm', { clerk: 0, d1: 1, r2: 0 }, c, view);
  expect(warm.thrown).toBeUndefined();
  for (const key of cache.entries.keys()) if (key.endsWith(`/view/${route.split('/').at(-1)}.json`)) cache.entries.delete(key);
  const cold = await expectWithinBudget(route + ' cold', { clerk: 0, d1: 1, r2: 1 }, c, view);
  expect(cold.thrown).toBeUndefined();
  expect(cold.counts.r2).toBe(1);
  console.log(route, JSON.stringify({ warm: warm.counts, cold: cold.counts }));
});
