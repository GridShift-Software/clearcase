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

import { load as elements_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/elements_tab/+page.server.ts';
import { load as legality_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/legality_tab/+page.server.ts';
import { load as contracts_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/contracts_tab/+page.server.ts';
import { load as quantum_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/quantum_tab/+page.server.ts';
import { load as invoice_ledger_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/invoice_ledger_tab/+page.server.ts';
import { load as prescription_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/prescription_tab/+page.server.ts';
export const realRoutes = [
  ['litigation/elements_tab', elements_tab],
  ['litigation/legality_tab', legality_tab],
  ['evidence/contracts_tab', contracts_tab],
  ['quantum/quantum_tab', quantum_tab],
  ['quantum/invoice_ledger_tab', invoice_ledger_tab],
  ['quantum/prescription_tab', prescription_tab]
] as const;

test.each(realRoutes)('%s real route matches local props with a request clock', async (route, load) => {
  const { builtCase, published, locals, CASE_ID } = await import('./world.ts');
  const b = await builtCase();
  try {
    const dep = await published(b);
    const local = await localLoad({ store: lc.store, resultsVersion: fixture.resultsVersion }, route);
    const services = locals(dep);
    services.runtime.now = () => new Date('2207-02-03T22:30:00Z');
    const { base, empty, ...hosted } = await load({ locals: services, params: { caseId: CASE_ID, version: b.built.record.resultsVersion } } as never);
    if (route.endsWith('prescription_tab')) local.asOf = '2207-02-04';
    expect(base).toBe(`/cases/${CASE_ID}/v`);
    expect(empty).toBe(false);
    expect(hosted).toStrictEqual(local);
    if ('asOf' in hosted) expect(hosted.asOf).toBe('2207-02-04');
  } finally { await b.cleanup(); }
}, 120_000);
