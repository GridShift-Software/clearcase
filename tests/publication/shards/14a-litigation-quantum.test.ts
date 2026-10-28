import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { localLoad } from '../../../scripts/publish/local-loader.ts';
import family, { routes } from '../../../scripts/publish/shards/views-litigation-quantum.ts';
import { cleanup, service, tempRoot } from '../../../src/lib/local-case/test-support.ts';
import { viewContentOf } from '../../../src/lib/local-case/results.server.ts';
import { buildCase } from '../../e2e/pilot/lib/fixtures.ts';

const root = await tempRoot('14a-seam');
const lc = service(path.join(root, 'store'));
await lc.startup();
const fixture = await buildCase(path.join(root, 'case'), { caseId: 'litigation-test' });
await lc.importPackage(fixture.caseDir, fixture.pkgDir);
afterAll(async () => { await lc.shutdown(); await cleanup(root); });

test('six published shards preserve the local loader props, with the clock excluded', async () => {
  const ctx = { store: lc.store, resultsVersion: fixture.resultsVersion, caseId: 'litigation-test', vc: viewContentOf(lc.store, fixture.resultsVersion), pure: { store: lc.store, vid: fixture.resultsVersion, vc: viewContentOf(lc.store, fixture.resultsVersion) }, json: (name: string, value: unknown) => ({ name, bytes: new TextEncoder().encode(JSON.stringify(value)) }) };
  const shards = await family.build(ctx);
  expect(shards).toHaveLength(6);
  for (const [id, route] of Object.entries(routes)) {
    const local = await localLoad(ctx, route);
    if (id === 'prescription_tab') delete local.asOf;
    const shard = shards.find((s) => s.name === `view/${id}.json`);
    expect(shard).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(shard!.bytes))).toEqual(local);
  }
});

test('hosted loaders return the same props as the local loaders', async () => {
  const { builtCase, published, locals, CASE_ID } = await import('./world.ts');
  const b = await builtCase();
  try {
    const dep = await published(b);
    for (const [id, route] of Object.entries(routes)) {
      const { datasetView } = await import('../../../src/lib/views/hosted/payloads.server.ts');
      const props = await datasetView(id as keyof typeof routes, () => false)({ locals: locals(dep), params: { caseId: CASE_ID, version: b.built.record.resultsVersion } } as never);
      const { base, empty, ...hosted } = props;
      expect(base).toBe(`/cases/${CASE_ID}/v`);
      expect(empty).toBe(false);
      expect(hosted).toEqual(JSON.parse(new TextDecoder().decode(b.files.get(`view/${id}.json`)!)));
    }
  } finally { await b.cleanup(); }
}, 120_000);
