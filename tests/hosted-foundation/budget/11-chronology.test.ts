// Sprint ticket 11: what the hosted chronology costs over the published synthetic version (two list pages). One page view
// is the version layout's load and the chronology's, as SvelteKit runs them for one request; `list.json?page=2` is one
// request of its own. Every request builds its services afresh, as hosted/services.ts does, with the production case
// authorizer (grant query, case directory, audit append) and the production request audit sink over the same counted D1;
// only the Cache API is shared between requests. Clerk is not in the loop: its session checks are 09a's.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as chronologyLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/+page.server.ts';
import { GET as listGet } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/list.json/+server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { builtCase, CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/**
 * The measured baseline, as a ceiling: not the ticket's acceptance budget (a page view at most 1 D1 and 1 R2 cold;
 * `list.json?page=2` no D1 beyond the authorization, 1 R2 cold and none warm), which this path does not meet yet.
 * Per request, warm:
 *   - the storage gate, once per fresh service graph: 1 D1 (rs_storage_identity) and 1 R2 (identity/client.json);
 *   - one case authorization (publishedVersion is memoised per request): 5 D1 (grants, case directory, audit binding,
 *     audit insert, audit readback);
 *   - the publication row with the admitted shard names: 1 D1.
 * Ticket 09b's single per-request grant lookup and its per-request gate cut the D1 side. Shard reads are this ticket's
 * own: none warm, one per cold shard (the page view's facets and first list page; the endpoint's one page).
 */
const PAGE_WARM: Budget = { clerk: 0, d1: 7, r2: 1 };
const LIST_WARM: Budget = { clerk: 0, d1: 7, r2: 1 };
const plus = (b: Budget, r2: number): Budget => ({ ...b, r2: b.r2! + r2 });

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests, fresh services per request. */
function client() {
  const c = counters(), cache = memoryShardCache(), db = countedD1(dep.db, c);
  const at = `https://client-a.example.invalid/cases/${CASE_ID}/v/${encodeURIComponent(b.built.record.resultsVersion)}/chronology`;
  let authorizations = 0;
  const request = async <T>(url: string, run: (e: never) => Promise<T>) => {
    const authority = await realAuthority(dep, db);
    const l = locals(dep, { identity: authority.identity, audit: authority.audit, db, r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
    const e = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL(url), request: new Request(url) } as never;
    try { return await run(e); } finally { authorizations = authority.counted.authorizations; }
  };
  const view = () => request(at, (e) => Promise.all([layoutLoad(e), chronologyLoad(e)]));
  const list = (q: string) => request(`${at}/list.json${q}`, async (e) => { const r = (await listGet(e)) as Response; if (!r.ok) throw new Error(String(r.status)); return r.text(); });
  const evict = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, view, list, evict, authorizations: () => authorizations };
}

describe('11 chronology budget', () => {
  test('page view: a fully cold first visit reads the shell, facets and page 1; warm, no shard; one authorization', async () => {
    const w = client();
    const cold = await expectWithinBudget('11 chronology page (fully cold)', plus(PAGE_WARM, 3), w.c, w.view);
    expect(cold.thrown).toBeUndefined();
    const warm = await expectWithinBudget('11 chronology page (warm)', PAGE_WARM, w.c, w.view);
    expect([warm.thrown, w.authorizations(), cold.counts.r2 - warm.counts.r2, cold.counts.d1]).toEqual([undefined, 1, 3, warm.counts.d1]);
    w.evict('/list/page-1.json');
    const one = await expectWithinBudget('11 chronology page (cold page 1)', plus(PAGE_WARM, 1), w.c, w.view);
    expect([one.thrown, one.counts.r2 - warm.counts.r2]).toEqual([undefined, 1]);
    console.log(`11 chronology page budget, fresh services per request, production authorizer and audit: fully cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}, cold page 1 ${JSON.stringify(one.counts)}; ${w.authorizations()} authorize call per page view`);
  });

  test('list.json?page=2: one authorization; 1 R2 read cold beyond the gate, none warm; ?all=1 warm reads no shard', async () => {
    const w = client();
    await measure(w.c, w.view); // the page's own first request warms the shell, facets and page 1
    const cold = await expectWithinBudget('11 list.json?page=2 (cold)', plus(LIST_WARM, 1), w.c, () => w.list('?page=2'));
    const warm = await expectWithinBudget('11 list.json?page=2 (warm)', LIST_WARM, w.c, () => w.list('?page=2'));
    expect([cold.thrown, warm.thrown, w.authorizations(), cold.counts.r2 - warm.counts.r2, cold.counts.d1]).toEqual([undefined, undefined, 1, 1, warm.counts.d1]);
    const all = await expectWithinBudget('11 list.json?all=1 (warm)', LIST_WARM, w.c, () => w.list('?all=1'));
    expect(all.thrown).toBeUndefined();
    console.log(`11 list budget, fresh services per request: page 2 cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}; ?all=1 warm ${JSON.stringify(all.counts)}`);
  });
});
