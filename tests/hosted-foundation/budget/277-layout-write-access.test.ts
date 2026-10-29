// GRS-277: the hosted version layout tells its pages whether the signed-in person may write the case's user work, from the
// request's one case lookup: a viewer grant gives false, an editor grant true, and asking costs no D1 query of its own.
// Synthetic SQLite/D1 doubles over the production one-lookup path; not a deployed Worker.
import { expect, it } from 'vitest';
import { load as layout } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { docCase } from '../../publication/shards/12-world.ts';
import { CASE_ID, published } from '../../publication/shards/world.ts';
import { counters, measure } from './harness.ts';
import { oneLookupLocals } from './one-lookup.ts';

it('277 the layout says a viewer cannot write and an editor can, with the same D1 queries either way', async () => {
  const b = await docCase(), pending: Promise<void>[] = [];
  try {
    const dep = await published(b), c = counters(), cache = memoryShardCache();
    const visit = async () => {
      const { l } = await oneLookupLocals(dep, c, cache, pending);
      return layout({ locals: l, params: { caseId: CASE_ID, version: b.built.record.resultsVersion }, url: new URL('https://client-a.example.invalid/') } as never);
    };
    await measure(c, visit); await Promise.all(pending.splice(0));
    const viewer = await measure(c, visit); await Promise.all(pending.splice(0));
    expect(viewer.thrown).toBeUndefined();
    expect(viewer.value?.canWrite).toBe(false);
    dep.db.sqlite.prepare("UPDATE tenant_case_grants SET role = 'editor' WHERE grant_id = 'g-viewer'").run();
    const editor = await measure(c, visit); await Promise.all(pending.splice(0));
    expect(editor.value?.canWrite).toBe(true);
    // the grant and case come from the page's one lookup: the layout asks nothing more for the role
    expect(editor.counts).toEqual(viewer.counts);
    expect(viewer.counts.clerk).toBe(0);
    console.log('277 layout visit (production authority, warm)', viewer.counts);
  } finally { await Promise.all(pending); await b.cleanup(); }
});
