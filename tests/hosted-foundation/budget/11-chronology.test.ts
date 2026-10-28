// Sprint ticket 11: what the hosted chronology costs over the published synthetic version (two list pages). One page view
// (the version layout's load and the chronology's, as SvelteKit runs them for one request) makes one D1 query, the
// publication row (authorized like a case read), and reads only the facets shard cold: the list pages are a request of
// their own. `list.json?page=2` makes no D1 query beyond that request's memoised authorization, one R2 read cold and
// none warm. The harness identity makes no grant query (harness.ts); production's adds one to each.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as chronologyLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/+page.server.ts';
import { GET as listGet } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/list.json/+server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import { PAGE_VIEW, type Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

const LIST_COLD: Budget = { clerk: 0, d1: 1, r2: 1 };
const LIST_WARM: Budget = { clerk: 0, d1: 1, r2: 0 };
const PAGE_WARM: Budget = { clerk: 0, d1: 1, r2: 0 };

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests; each call is one request. */
function client() {
  const c = counters(), cache = memoryShardCache();
  const l = locals(dep, { db: countedD1(dep.db, c), r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
  const at = `https://client-a.example.invalid/cases/${CASE_ID}/v/${encodeURIComponent(b.built.record.resultsVersion)}/chronology`;
  const event = (url: string) => ({ locals: { ...l }, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL(url), request: new Request(url) }) as never;
  const view = async () => { const e = event(at); return Promise.all([layoutLoad(e), chronologyLoad(e)]); };
  const list = async (q: string) => { const r = (await listGet(event(`${at}/list.json${q}`))) as Response; if (!r.ok) throw new Error(String(r.status)); return r.text(); };
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, view, list, evict };
}

describe('11 chronology budget', () => {
  test('page view: 1 D1 query; warm 0 R2 reads, cold facets shard 1', async () => {
    const w = client();
    const first = await measure(w.c, w.view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('11 chronology page (warm)', PAGE_WARM, w.c, w.view);
    expect(warm.thrown).toBeUndefined();
    w.evict('/list/facets.json');
    const cold = await expectWithinBudget('11 chronology page (cold facets shard)', PAGE_VIEW, w.c, w.view);
    expect(cold.counts.r2).toBe(1);
    expect(cold.counts.d1).toBe(1);
    console.log(`11 chronology page budget: first visit ${JSON.stringify(first.counts)} (storage gate, shell and facets), warm ${JSON.stringify(warm.counts)}, cold facets ${JSON.stringify(cold.counts)}`);
  });

  test('list.json?page=2: only the authorization in D1; 1 R2 read cold, 0 warm', async () => {
    const w = client();
    await measure(w.c, () => w.list('?page=1')); // the storage gate's first read, as on the page's own first request
    const cold = await expectWithinBudget('11 list.json?page=2 (cold)', LIST_COLD, w.c, () => w.list('?page=2'));
    expect(cold.thrown).toBeUndefined();
    expect(cold.counts.r2).toBe(1);
    const warm = await expectWithinBudget('11 list.json?page=2 (warm)', LIST_WARM, w.c, () => w.list('?page=2'));
    expect(warm.counts.r2).toBe(0);
    const all = await expectWithinBudget('11 list.json?all=1 (warm)', LIST_WARM, w.c, () => w.list('?all=1'));
    expect(all.thrown).toBeUndefined();
    console.log(`11 list budget: page 2 cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}; ?all=1 warm ${JSON.stringify(all.counts)}`);
  });
});
