// Fresh production-authorized visits; only the immutable shard cache survives between requests.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { builtCase, published, CASE_ID, type BuiltCase, type Deployment } from '../../publication/shards/world';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server';
import { counters, expectWithinBudget, measure } from './harness';
import { oneLookupLocals } from './one-lookup';

const routes = ['evidence/filings_tab', 'quantum/payments_tab', 'quantum/interest_calc_tab', 'quantum/settlement_tab',
  'litigation/enforcement_tab', 'litigation/crossexam_tab', 'litigation/authorities_tab', 'litigation/heads_tab', 'analysis/info_required_tab'];
const hosted = import.meta.glob('../../../deploy/client/routes/**/+page.server.ts');
let b: BuiltCase, dep: Deployment;
const pending: Promise<void>[] = [];
const flushAudit = () => Promise.all(pending.splice(0));
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(async () => { await flushAudit(); await b?.cleanup(); });

// Measured ceilings, per owner approval 976cc115. Ticket target: <=1 user-work D1 beyond authorization,
// <=1 cold view R2; MET (one shared grant/publication query + one combined work query, one view shard).
// Fully cold first visit also reads shell.json, so the sprint-wide <=1 total cold R2 target is NOT met there.
// Deferred production audit adds one D1 after the response, asserted separately and flushed before the next visit.
const FIRST = { clerk: 0, d1: 2, r2: 2 };
const WARM = { clerk: 0, d1: 2, r2: 0 };
const COLD = { clerk: 0, d1: 2, r2: 1 };

describe('14b mixed-page production request budget', () => {
  test.each(routes)('%s: fresh first, warm and cold-view visits', async (route) => {
    const c = counters(), cache = memoryShardCache();
    const h = await hosted[`../../../deploy/client/routes/cases/[caseId]/v/[version]/${route}/+page.server.ts`]!() as { load: (event: never) => Promise<unknown> };
    const run = async () => {
      const { l } = await oneLookupLocals(dep, c, cache, pending);
      const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion } } as never;
      return Promise.all([layoutLoad(event), h.load(event)]);
    };
    const first = await expectWithinBudget(route + ' first', FIRST, c, run);
    expect(first.thrown).toBeUndefined(); expect(first.counts).toMatchObject(FIRST);
    await flushAudit(); expect(c.d1).toBe(first.counts.d1 + 1);
    const warm = await expectWithinBudget(route + ' warm', WARM, c, run);
    expect(warm.thrown).toBeUndefined(); expect(warm.counts).toMatchObject(WARM);
    await flushAudit(); expect(c.d1).toBe(warm.counts.d1 + 1);
    for (const key of cache.entries.keys()) if (key.endsWith(`/view/${route.split('/')[1]}.json`)) cache.entries.delete(key);
    const cold = await expectWithinBudget(route + ' cold view', COLD, c, run);
    expect(cold.thrown).toBeUndefined(); expect(cold.counts).toMatchObject(COLD);
    await flushAudit(); expect(c.d1).toBe(cold.counts.d1 + 1);
    dep.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2200-01-01T00:00:00Z' WHERE grant_id = 'g-viewer'");
    try {
      const denied = await measure(c, run);
      expect(denied.thrown).toBeDefined();
      expect(denied.counts).toMatchObject({ clerk: 0, d1: 1, r2: 0 });
      await flushAudit();
    } finally { dep.db.exec("UPDATE tenant_case_grants SET state = 'active', revoked_at = NULL WHERE grant_id = 'g-viewer'"); }
    console.log(`14b ${route} foreground ${JSON.stringify({ first: first.counts, warm: warm.counts, cold: cold.counts })}; deferred audit +1 D1`);
  });
});
