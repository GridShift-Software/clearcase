// Sprint ticket 12: what the documents list and the document page cost as SvelteKit runs them for one request (the
// version layout's load and the page's), over the published synthetic version. The harness identity makes no grant query
// (harness.ts), so the budgets here are the page budget less that one query.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as docLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as documentsLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/documents/+page.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { docCase, KID_OK, PARENT } from '../../publication/shards/12-world.ts';
import { CASE_ID, locals, published, type BuiltCase, type Deployment } from '../../publication/shards/world.ts';
import type { Budget } from './budget.ts';
import { counters, countedD1, countedR2, expectWithinBudget, measure } from './harness.ts';

/** The grant query production's identity makes and the harness identity does not. */
const GRANT_QUERY = 1;
// Documents list: the publication read (which authorizes the case), at most one shard. Warm, no R2.
const LIST_WARM: Budget = { clerk: 0, d1: 1 - GRANT_QUERY + 1, r2: 0 };
const LIST_COLD: Budget = { clerk: 0, d1: 1 - GRANT_QUERY + 1, r2: 1 };
// Document page: the same, and the one links call for its own original.
const DOC_WARM: Budget = { clerk: 0, d1: 2 - GRANT_QUERY + 1, r2: 0 };
const DOC_COLD: Budget = { clerk: 0, d1: 2 - GRANT_QUERY + 1, r2: 1 };

let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
  b = await docCase(); dep = await published(b);
  for (const ref of [KID_OK, PARENT]) {
    const hash = Buffer.from(ref.padEnd(32, '_')).toString('hex');
    dep.db.sqlite.prepare('INSERT INTO rs_original (sha256, size, object_key, etag, media_family) VALUES (?, 4, ?, ?, ?)').run(hash, `orig/${hash}`, 'e', 'pdf');
    dep.db.sqlite.prepare('INSERT INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES (?, ?, ?, ?, ?, ?)').run(CASE_ID, ref, hash, `${ref}.pdf`, 'application/pdf', '2001-01-01T00:00:00Z');
  }
}, 120_000);
afterAll(() => b?.cleanup());

/** One client: counted D1, storage R2 and shard reads, one Cache API shared by its requests. */
function client() {
  const c = counters(), cache = memoryShardCache();
  const l = locals(dep, { db: countedD1(dep.db, c), r2: countedR2(dep.r2, c), bucket: countedR2(dep.bucket, c), cache });
  const view = (load: (e: never) => Promise<unknown>, params: Record<string, string>, search = '') => async () => {
    const event = { locals: { ...l }, params: { caseId: CASE_ID, version: b.built.record.resultsVersion, ...params }, url: new URL(`https://client-a.example.invalid/${search}`) } as never;
    return Promise.all([layoutLoad(event), load(event)]);
  };
  const coldShard = (suffix: string) => { for (const k of [...cache.entries.keys()]) if (k.endsWith(suffix)) cache.entries.delete(k); };
  return { c, cache, view, coldShard };
}

describe('12 documents list and document page budget', () => {
  test('documents list, no filter: warm 0 R2 reads; cold default shard 1 R2 read; 1 D1 query', async () => {
    const w = client();
    const view = w.view(documentsLoad as never, {});
    const first = await measure(w.c, view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('12 documents (warm)', LIST_WARM, w.c, view);
    expect(warm.thrown).toBeUndefined();
    w.coldShard('/documents/default.json');
    const cold = await expectWithinBudget('12 documents (cold default shard)', LIST_COLD, w.c, view);
    expect([cold.counts.r2, cold.counts.d1]).toEqual([1, 1]);
    console.log(`12 documents budget: first visit ${JSON.stringify(first.counts)} (shell and default shard), warm ${JSON.stringify(warm.counts)}, cold ${JSON.stringify(cold.counts)}`);
  });

  test('documents list, bundle filter: warm 0 R2 reads and 1 D1 query however many list pages the case has', async () => {
    const w = client();
    const view = w.view(documentsLoad as never, {}, '?bundle=Bulk%20A');
    const first = await measure(w.c, view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('12 documents bundle (warm)', LIST_WARM, w.c, view);
    expect(warm.thrown).toBeUndefined();
    console.log(`12 documents bundle budget: first visit ${JSON.stringify(first.counts)} (${b.built.manifest.counts.listPages} list pages), warm ${JSON.stringify(warm.counts)}`);
  });

  test('document page: warm 0 R2 reads; cold doc shard 1 R2 read; the publication read and one links call, none per attachment', async () => {
    const w = client();
    const view = w.view(docLoad as never, { ref: PARENT });
    const first = await measure(w.c, view);
    expect(first.thrown).toBeUndefined();
    const warm = await expectWithinBudget('12 document page (warm)', DOC_WARM, w.c, view);
    expect(warm.thrown).toBeUndefined();
    w.coldShard(`/doc/${PARENT}.json`);
    const cold = await expectWithinBudget('12 document page (cold doc shard)', DOC_COLD, w.c, view);
    expect([cold.counts.r2, cold.counts.d1]).toEqual([1, 2]);
    const data = (cold.value as [unknown, { attachments: unknown[] }])[1];
    expect(data.attachments.length).toBeGreaterThan(1);
    console.log(`12 document budget: first visit ${JSON.stringify(first.counts)}, warm ${JSON.stringify(warm.counts)}, cold ${JSON.stringify(cold.counts)}, ${data.attachments.length} attachments`);
  });
});
