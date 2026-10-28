import { afterAll, beforeAll, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, measure } from './harness.ts';
import { load as elements_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/elements_tab/+page.server.ts';
import { load as legality_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/legality_tab/+page.server.ts';
import { load as contracts_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/contracts_tab/+page.server.ts';
import { load as quantum_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/quantum_tab/+page.server.ts';
import { load as invoice_ledger_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/invoice_ledger_tab/+page.server.ts';
import { load as prescription_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/prescription_tab/+page.server.ts';
const realRoutes = [
  ['litigation/elements_tab', elements_tab],
  ['litigation/legality_tab', legality_tab],
  ['evidence/contracts_tab', contracts_tab],
  ['quantum/quantum_tab', quantum_tab],
  ['quantum/invoice_ledger_tab', invoice_ledger_tab],
  ['quantum/prescription_tab', prescription_tab]
] as const;
let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());
test.each(realRoutes)('%s cold and warm acceptance budgets with fresh production authority', async (route, load) => {
  const c = counters(), cache = memoryShardCache(), db = countedD1(dep.db, c);
  const visit = async () => {
    const authority = await realAuthority(dep, db);
    const services = locals(dep, { identity: authority.identity, audit: authority.audit, db, r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
    const event = { locals: services, params: { caseId: CASE_ID, version: b.built.record.resultsVersion } } as never;
    return Promise.all([layoutLoad(event), load(event)]);
  };
  const first = await measure(c, visit);
  const warm = await measure(c, visit);
  for (const key of cache.entries.keys()) if (key.endsWith(`/view/${route.split('/').at(-1)}.json`)) cache.entries.delete(key);
  const cold = await measure(c, visit);
  console.log(route, JSON.stringify({ first: first.counts, warm: warm.counts, cold: cold.counts }));
  for (const result of [first, warm, cold]) {
    expect.soft(result.thrown).toBeUndefined();
    expect.soft(result.counts.clerk).toBe(0);
    expect.soft(result.counts.d1).toBeLessThanOrEqual(1);
  }
  expect.soft(first.counts.r2).toBeLessThanOrEqual(2); // Shell plus view, both cold.
  expect.soft(cold.counts.r2).toBeLessThanOrEqual(1);
  expect.soft(warm.counts.r2).toBe(0);
});
