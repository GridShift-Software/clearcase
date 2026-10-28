// Incremental route budget beyond authorization: real user-work D1 adapter, real shard reader and fresh per-request services.
// The authority/publication double is intentionally outside this counter; 09b tests its shared one-query lookup.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { builtCase, type BuiltCase } from '../../publication/shards/world';
import { fixture, CASE } from '../user-work/helpers';
import { CLIENT, LIMITS, d1 } from '../user-work/world';
import { createD1UserWork } from '../../../src/lib/user-work/hosted';
import { createShardReader, shardPrefix } from '../../../src/lib/results/hosted/shards';
import { memoryShardBucket, memoryShardCache } from '../../../src/lib/server/runtime/memory-shards';
import { resultsVersion } from '../../../src/lib/server/runtime/ids';
import type { CaseReader, RequestServices } from '../../../src/lib/server/runtime/contracts';
import { counters, countedD1, countedR2, measure, assertWithinBudget } from './harness';

const routes = ['evidence/filings_tab', 'quantum/payments_tab', 'quantum/interest_calc_tab', 'quantum/settlement_tab',
  'litigation/enforcement_tab', 'litigation/crossexam_tab', 'litigation/authorities_tab', 'litigation/heads_tab', 'analysis/info_required_tab'];
const hosted = import.meta.glob('../../../deploy/client/routes/**/+page.server.ts');
let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());

describe('14b incremental mixed-page budget', () => {
  test.each(routes)('%s: at most one user-work D1 call and one cold R2 read', async (route) => {
    const f = fixture(), c = counters();
    const rv = resultsVersion(b.built.record.resultsVersion);
    const store = new Proxy(f.reader.reader, { get(target, key) {
      if (key === 'publication') return async () => ({ versionId: rv, publishedAt: null, previousVersionId: null,
        shardManifestSha256: b.built.manifestSha256, shards: Object.fromEntries([...b.files].map(([name, data]) => [name, data.byteLength])) });
      if (key === 'seeds') return async () => b.built.record.rows.seeds.map((s) => ({ datasetKey: s.dataset_key, seedId: s.seed_id, seedSha256: s.seed_sha256, record: JSON.parse(s.record_json) }));
      return Reflect.get(target, key);
    } }) as CaseReader;
    const bucket = memoryShardBucket(new Map([...b.files].map(([name, bytes]) => [shardPrefix(rv) + name, bytes])));
    const cache = memoryShardCache();
    const request = () => ({ store,
      userWork: createD1UserWork({ db: countedD1(d1(f.db), c), config: { clientId: CLIENT, limits: LIMITS }, identity: f.auth.identity(), audit: f.audit.sink, store, now: () => new Date('2200-01-01T00:00:00Z') }),
      shards: createShardReader({ bucket: countedR2(bucket, c), clientId: CLIENT, cache }),
    } as RequestServices);
    try {
      const h = await hosted[`../../../deploy/client/routes/cases/[caseId]/v/[version]/${route}/+page.server.ts`]!() as { load: (event: unknown) => Promise<unknown> };
      const run = () => h.load({ locals: request(), params: { caseId: CASE, version: rv } });
      const cold = await measure(c, run);
      const warm = await measure(c, run);
      console.log(`14b ${route}: cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}`);
      expect(cold.thrown).toBeUndefined(); expect(warm.thrown).toBeUndefined();
      assertWithinBudget(`14b ${route} cold`, cold.counts, { clerk: 0, d1: 1, r2: 1 });
      assertWithinBudget(`14b ${route} warm`, warm.counts, { clerk: 0, d1: 1, r2: 0 });
    } finally { f.db.close(); }
  });
});
