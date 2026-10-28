// Sprint ticket 12: what the documents list and the document page cost as SvelteKit runs them for one request (the version
// layout's load and the page's) over the published synthetic version. As in 06-overview.test.ts, every request builds its
// services afresh (one-lookup.ts), with the production case authorizer over 09b's single grant lookup and the deferred
// request audit sink; only the Cache API is shared between requests. Clerk is not in the loop (09a's).
// Each route is measured fully cold (nothing in the Cache API), then warm.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as docLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as documentsLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/documents/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { docCase, KID_OK, PARENT } from '../../publication/shards/12-world.ts';
import { CASE_ID, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, expectWithinBudget, measure } from './harness.ts';
import { oneLookupLocals } from './one-lookup.ts';

/**
 * The measured ceilings after 09b's one-lookup path, as in 13-analysis.test.ts. Ticket target: 0 Clerk, 1 D1 beyond
 * authorization, 1 R2 cold. Documents list: warm 1 D1 and 0 R2, fully cold 1 D1 and 2 R2 (shell, default shard); target MET, and
 * cold is one read per cold shard. Document page: warm 3 D1 and 1 R2, fully cold 3 D1 and 3 R2; target NOT met. Its one links
 * call for the original runs its own authorization (a second authorize call), which costs 2 D1 and 1 R2 beyond the layout's
 * lookup and shard reads, and two deferred audit inserts, not one. The deferred audit inserts add D1 after the response,
 * asserted separately, never counted in the next visit.
 * Before 09b: list 7 D1 and 1 R2 warm, 3 R2 cold; document page 14 D1 and 2 R2 warm, 4 R2 cold.
 */
const LIST: Budget = { clerk: 0, d1: 1, r2: 0 };
const DOC: Budget = { clerk: 0, d1: 3, r2: 1 };
const DOC_AUDITS = 2;

let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
  b = await docCase(); dep = await published(b);
  // The originals the case loader (07) stored, so the page's links call finds its row.
  for (const ref of [KID_OK, PARENT]) {
    const hash = Buffer.from(ref.padEnd(32, '_')).toString('hex');
    dep.db.sqlite.prepare('INSERT INTO rs_original (sha256, size, object_key, etag, media_family) VALUES (?, 4, ?, ?, ?)').run(hash, `orig/${hash}`, 'e', 'pdf');
    dep.db.sqlite.prepare('INSERT INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES (?, ?, ?, ?, ?, ?)').run(CASE_ID, ref, hash, `${ref}.pdf`, 'application/pdf', '2001-01-01T00:00:00Z');
  }
}, 120_000);
const pending: Promise<void>[] = [];
const flushAudit = () => Promise.all(pending.splice(0));
afterAll(async () => { await flushAudit(); await b?.cleanup(); });

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests, fresh services per request. */
function client() {
  const c = counters(), cache = memoryShardCache();
  let authorizations = 0;
  const view = (load: (e: never) => Promise<unknown>, params: Record<string, string>, search = '') => async () => {
    const services = await oneLookupLocals(dep, c, cache, pending);
    const event = { locals: services.l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ...params }, url: new URL(`https://client-a.example.invalid/${search}`) } as never;
    try { return await Promise.all([layoutLoad(event), load(event)]); } finally { authorizations = services.authorizations(); }
  };
  return { c, cache, view, authorizations: () => authorizations };
}

describe('12 documents list and document page budget', () => {
  test('documents list, no filter: fully cold is 2 R2 reads (shell, default shard); warm 0 shard reads', async () => {
    const w = client(), view = w.view(documentsLoad as never, {});
    const cold = await expectWithinBudget('12 documents (fully cold)', { ...LIST, r2: 2 }, w.c, view);
    expect([cold.thrown, cold.counts.r2]).toEqual([undefined, 2]);
    await flushAudit();
    expect(w.c.d1).toBe(cold.counts.d1 + 1);
    const warm = await expectWithinBudget('12 documents (warm)', LIST, w.c, view);
    expect([warm.thrown, w.authorizations()]).toEqual([undefined, 1]);
    await flushAudit();
    expect(w.c.d1).toBe(warm.counts.d1 + 1);
    console.log(`12 documents budget, fresh services per request, one-lookup authorizer and deferred audit (+1 D1 each): fully cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}; ${w.authorizations()} authorize call per page view`);
  });

  test('documents list, bundle filter: reads every list page (cold) and none warm', async () => {
    const w = client(), view = w.view(documentsLoad as never, {}, '?bundle=Bulk%20A');
    const listPages = b.built.manifest.counts.listPages;
    const cold = await expectWithinBudget('12 documents bundle (fully cold)', { ...LIST, r2: 1 + listPages }, w.c, view);
    expect(cold.thrown).toBeUndefined();
    await flushAudit();
    expect(w.c.d1).toBe(cold.counts.d1 + 1);
    const warm = await expectWithinBudget('12 documents bundle (warm)', LIST, w.c, view);
    expect([warm.thrown, cold.counts.r2 - warm.counts.r2]).toEqual([undefined, 1 + listPages]);
    await flushAudit();
    expect(w.c.d1).toBe(warm.counts.d1 + 1);
    console.log(`12 documents bundle budget: fully cold ${JSON.stringify(cold.counts)} (${listPages} list pages, shell), warm ${JSON.stringify(warm.counts)}`);
  });

  test('document page: fully cold is 2 R2 reads (shell, doc shard); warm 0; one links call, none per attachment', async () => {
    const w = client(), view = w.view(docLoad as never, { ref: PARENT });
    const cold = await expectWithinBudget('12 document page (fully cold)', { ...DOC, r2: DOC.r2! + 2 }, w.c, view);
    expect(cold.thrown).toBeUndefined();
    await flushAudit();
    expect(w.c.d1).toBe(cold.counts.d1 + DOC_AUDITS);
    const warm = await expectWithinBudget('12 document page (warm)', DOC, w.c, view);
    expect([warm.thrown, cold.counts.r2 - warm.counts.r2, w.authorizations()]).toEqual([undefined, 2, 2]);
    await flushAudit();
    expect(w.c.d1).toBe(warm.counts.d1 + DOC_AUDITS);
    const data = (warm.value as [unknown, { attachments: unknown[] }])[1];
    expect(data.attachments.length).toBeGreaterThan(1);
    console.log(`12 document budget: fully cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}, ${data.attachments.length} attachments, ${w.authorizations()} authorize calls per page view`);
  });
});
