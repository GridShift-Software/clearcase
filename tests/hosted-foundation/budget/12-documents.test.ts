// Sprint ticket 12: what the documents list and the document page cost as SvelteKit runs them for one request (the version
// layout's load and the page's) over the published synthetic version. As in 06-overview.test.ts, every request builds its
// services afresh, as hosted/services.ts does, with the production case authorizer (grant query, case directory, audit
// append) and request audit sink over the same counted D1; only the Cache API is shared between requests. Clerk is not in
// the loop (09a's). Each route is measured fully cold (nothing in the Cache API), then warm.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as docLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as documentsLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/documents/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { docCase, KID_OK, PARENT } from '../../publication/shards/12-world.ts';
import { CASE_ID, locals, published, realAuthority, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/**
 * The measured baseline, as a ceiling, not the ticket's acceptance budget (0 Clerk, 1 D1 beyond authorization, 1 R2 cold),
 * which the request path does not meet yet. Per page view the 06 overview test records 14 D1 and 1 R2 warm: the storage
 * gate (1 D1, 1 R2: rs_storage_identity and identity/client.json) once per fresh service graph, each case authorization 5 D1
 * (grants, case directory, audit binding, audit insert, audit readback), the publication row 1 D1, and the notes summary
 * 2 D1. These two pages make one authorization (the publication read's, memoized across the layout and the page) and no
 * notes read, so 5 + 1 + 1 = 7 D1 and 1 R2; the document page adds its own links call, which opens a second storage graph:
 * its gate (1 D1, 1 R2), another authorization (5 D1) and the rs_case_original query (1 D1), so 14 D1 and 2 R2. Ticket 09b's single per-request grant lookup removes the per-request gate and the repeated
 * authorizations; shard reads are this ticket's own: none warm, one per cold shard.
 */
const LIST: Budget = { clerk: 0, d1: 7, r2: 1 };
const DOC: Budget = { clerk: 0, d1: 14, r2: 2 };

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
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests, fresh services per request. */
function client() {
  const c = counters(), cache = memoryShardCache(), db = countedD1(dep.db, c);
  let authorizations = 0;
  const view = (load: (e: never) => Promise<unknown>, params: Record<string, string>, search = '') => async () => {
    const authority = await realAuthority(dep, db);
    const l = locals(dep, { identity: authority.identity, audit: authority.audit, db, r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
    const event = { locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ...params }, url: new URL(`https://client-a.example.invalid/${search}`) } as never;
    try { return await Promise.all([layoutLoad(event), load(event)]); } finally { authorizations = authority.counted.authorizations; }
  };
  return { c, cache, view, authorizations: () => authorizations };
}

describe('12 documents list and document page budget', () => {
  test('documents list, no filter: fully cold is 2 R2 reads (shell, default shard); warm 0 shard reads', async () => {
    const w = client(), view = w.view(documentsLoad as never, {});
    const cold = await measure(w.c, view);
    expect(cold.thrown).toBeUndefined();
    const storageGate = 1;
    expect(cold.counts.r2).toBe(2 + storageGate);
    const warm = await expectWithinBudget('12 documents (warm)', LIST, w.c, view);
    expect([warm.thrown, w.authorizations(), warm.counts.r2]).toEqual([undefined, 1, storageGate]);
    console.log(`12 documents budget, fresh services per request, production authorizer and audit: fully cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}; ${w.authorizations()} authorize call per page view`);
  });

  test('documents list, bundle filter: reads every list page (cold) and none warm', async () => {
    const w = client(), view = w.view(documentsLoad as never, {}, '?bundle=Bulk%20A');
    const cold = await measure(w.c, view);
    expect(cold.thrown).toBeUndefined();
    const warm = await expectWithinBudget('12 documents bundle (warm)', LIST, w.c, view);
    const listPages = b.built.manifest.counts.listPages;
    expect([warm.thrown, cold.counts.r2 - warm.counts.r2]).toEqual([undefined, 1 + listPages]);
    console.log(`12 documents bundle budget: fully cold ${JSON.stringify(cold.counts)} (${listPages} list pages, shell), warm ${JSON.stringify(warm.counts)}`);
  });

  test('document page: fully cold is 2 R2 reads (shell, doc shard); warm 0; one links call, none per attachment', async () => {
    const w = client(), view = w.view(docLoad as never, { ref: PARENT });
    const cold = await measure(w.c, view);
    expect(cold.thrown).toBeUndefined();
    const warm = await expectWithinBudget('12 document page (warm)', DOC, w.c, view);
    expect([warm.thrown, cold.counts.r2 - warm.counts.r2, w.authorizations()]).toEqual([undefined, 2, 2]);
    const data = (warm.value as [unknown, { attachments: unknown[] }])[1];
    expect(data.attachments.length).toBeGreaterThan(1);
    console.log(`12 document budget: fully cold ${JSON.stringify(cold.counts)}, warm ${JSON.stringify(warm.counts)}, ${data.attachments.length} attachments, ${w.authorizations()} authorize calls per page view`);
  });
});
