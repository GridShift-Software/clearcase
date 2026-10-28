// Sprint ticket 06: the hosted version routes over a published synthetic version: the case page redirects to the
// overview, the layout and overview read the shards, every other registry view is coming soon or 404, and an unknown
// version or a case without a grant answers 404 or 403 without reading a shard.
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as caseLoad } from '../../../deploy/client/routes/cases/[caseId]/+page.server.ts';
import { load as layoutLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+layout.server.ts';
import { load as versionLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/+page.server.ts';
import { load as overviewLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/overview/+page.server.ts';
import { load as categoryLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/[category]/+page.server.ts';
import { load as viewLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/[category]/[view]/+page.server.ts';
import { memoryShardBucket } from '../../../src/lib/server/runtime/memory-shards.ts';
import { VIEWS } from '../../../src/lib/components/view-registry.ts';
import { hostedStatus } from '../../../src/lib/views/hosted/availability.ts';
import { grantedIdentity, ids } from '../../hosted-foundation/storage/fixture.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from './world.ts';

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

const rv = () => b.built.record.resultsVersion;
const event = (l = locals(dep), params: Record<string, string> = {}) => ({ locals: l, params: { caseId: CASE_ID, version: rv(), ...params }, url: new URL(`https://client-a.example.invalid/cases/${CASE_ID}`) }) as never;
async function status(run: () => unknown): Promise<number | string> {
  try { await run(); return 'ok'; } catch (e) {
    if (isHttpError(e)) return e.status;
    if (isRedirect(e)) return `${e.status} ${e.location}`;
    throw e;
  }
}
const overviewHref = () => `/cases/${CASE_ID}/v/${encodeURIComponent(rv())}/overview`;

describe('06 hosted version routes', () => {
  test('the case page and the version root redirect 303 to the published overview', async () => {
    expect(await status(() => caseLoad(event()))).toBe(`303 ${overviewHref()}`);
    expect(await status(() => versionLoad(event()))).toBe(`303 ${overviewHref()}`);
  });

  test('the layout returns the local layout version shape, the route base and the version pill', async () => {
    const data = await layoutLoad(event());
    expect([data.version.id, data.version.caseId, data.isActive, data.base, data.documents]).toEqual([rv(), CASE_ID, true, `/cases/${CASE_ID}/v`, b.built.manifest.counts.documents]);
    expect(data.shell.published).toMatchObject({ label: `Version ${rv().slice(7, 15)}`, documents: b.built.manifest.counts.documents });
    expect(data.shell.actions.map((a) => a.href)).toContain(`/cases/${CASE_ID}/notes`);
  });

  test('the overview merges the shard with notes and filled freshness and register slots', async () => {
    const data = await overviewLoad(event());
    expect(data.documents.total).toBe(b.built.manifest.counts.documents);
    expect(data.slots.map((s) => [s.slot.id, s.status])).toEqual([['deadlines', 'filled'], ['unbilled-time', 'filled'], ['rescan-freshness', 'filled']]); // 17a: the two register tiles
  });

  test('every registry view hosted marks soon is coming soon; one it ports, never shows, or does not know is 404 here', async () => {
    // The statuses are read from the availability table at run time: a ticket that ports a view flips its line there and
    // never edits this test. A ported view has its own route; this fallback never serves it.
    const fallback = (route: string) => {
      const [category, view] = route.slice(1).split('/');
      return view ? viewLoad(event(undefined, { category: category!, view })) : categoryLoad(event(undefined, { category: category! }));
    };
    expect(VIEWS.some((v) => hostedStatus(v.id) === 'never')).toBe(true);
    for (const v of VIEWS) {
      if (hostedStatus(v.id) === 'soon') expect(await fallback(v.route)).toMatchObject({ status: 'soon', view: { id: v.id } });
      else expect([v.id, await status(() => fallback(v.route))]).toEqual([v.id, 404]);
    }
    expect(await status(() => viewLoad(event(undefined, { category: 'analysis', view: 'nope' })))).toBe(404);
    expect(await status(() => categoryLoad(event(undefined, { category: 'nope' })))).toBe(404);
  });

  test('an unknown or malformed version is 404 and reads no shard', async () => {
    const bucket = memoryShardBucket(dep.bucket.objects);
    let reads = 0;
    const counted = { get: (k: string) => { reads++; return bucket.get(k); } };
    for (const version of [`sha256:${'0'.repeat(64)}`, 'latest', rv().toUpperCase()]) {
      expect(await status(() => layoutLoad(event(locals(dep, { bucket: counted }), { version })))).toBe(404);
      expect(await status(() => overviewLoad(event(locals(dep, { bucket: counted }), { version })))).toBe(404);
    }
    expect(reads).toBe(0);
  });

  test('a case without a grant is 404 or 403, and no shard is read', async () => {
    let reads = 0;
    const counted = { get: (k: string) => { reads++; return dep.bucket.get(k); } };
    const l = locals(dep, { identity: grantedIdentity(ids.clientA, []).identity, bucket: counted });
    for (const load of [layoutLoad, overviewLoad, caseLoad]) expect([403, 404]).toContain(await status(() => load(event(l))));
    expect(reads).toBe(0);
  });

  test('a shard the manifest names but storage lacks is a 503', async () => {
    const empty = memoryShardBucket();
    expect(await status(() => layoutLoad(event(locals(dep, { bucket: empty }))))).toBe(503);
  });
});
