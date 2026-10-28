// Fresh requests use 06's real authorization and audit harness. Counts are measured
// baselines, not the ticket acceptance target: 1 storage gate + 5 authorization/audit + 1 publication D1.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';
let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); await realAuthority(dep); }, 120_000);
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

test.each(routes)('%s measures first, warm and cold visits with fresh authorized services', async (route, load) => {
  const c = counters(), cache = memoryShardCache();
  const view = async () => {
    const db = countedD1(dep.db, c);
    const authority = await realAuthority(dep, db);
    const l = locals(dep, { db, identity: authority.identity, audit: authority.audit, bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c), cache });
    const event = { locals: l, params: { caseId: CASE_ID, version: b.synth.resultsVersion } } as never;
    return Promise.all([layoutLoad(event), load(event)]);
  };
  const first = await measure(c, view);
  expect(first.thrown).toBeUndefined();
  expect(first.counts).toMatchObject({ clerk: 0, d1: 7, r2: 3 });
  const warm = await expectWithinBudget(route + ' warm', { clerk: 0, d1: 7, r2: 1 }, c, view);
  expect(warm.thrown).toBeUndefined();
  for (const key of cache.entries.keys()) if (key.endsWith(`/view/${route.split('/').at(-1)}.json`)) cache.entries.delete(key);
  const cold = await expectWithinBudget(route + ' cold', { clerk: 0, d1: 7, r2: 2 }, c, view);
  expect(cold.thrown).toBeUndefined();
  expect(warm.counts).toMatchObject({ clerk: 0, d1: 7, r2: 1 });
  expect(cold.counts).toMatchObject({ clerk: 0, d1: 7, r2: 2 });
  dep.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2001-01-01T00:00:00Z' WHERE grant_id = 'g-viewer'");
  try {
    const denied = await measure(c, view);
    expect(denied.thrown).toBeDefined();
    expect(denied.counts.r2).toBe(1); // Storage identity gate only; authorization refuses the page.
  } finally { dep.db.exec("UPDATE tenant_case_grants SET state = 'active', revoked_at = NULL WHERE grant_id = 'g-viewer'"); }
  console.log(route, JSON.stringify({ first: first.counts, warm: warm.counts, cold: cold.counts }));
  // Keep acceptance red while shared request overhead exceeds the sprint budget (09b owns that work).
  for (const visit of [first, warm, cold]) expect.soft(visit.counts.d1, 'ticket: at most one D1 per page').toBeLessThanOrEqual(1);
  expect.soft(first.counts.r2, 'ticket: at most one cold R2 per page').toBeLessThanOrEqual(1);
  expect.soft(warm.counts.r2, 'ticket: no warm R2 reads').toBe(0);
  expect.soft(cold.counts.r2, 'ticket: at most one cold view R2 read').toBeLessThanOrEqual(1);
});
