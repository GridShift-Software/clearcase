import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { shardManifest } from '../../../scripts/publish/manifest.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { localLoad } from '../../../scripts/publish/local-loader.ts';
import { service } from '../../../src/lib/local-case/test-support.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from './world.ts';

let b: BuiltCase, dep: Deployment, lc: ReturnType<typeof service>;
beforeAll(async () => {
  b = await builtCase(); dep = await published(b);
  lc = service(path.join(b.root, 'parity-store')); await lc.startup();
  await lc.importPackage(b.synth.caseDir, b.synth.pkgDir);
}, 120_000);
afterAll(async () => { await lc?.shutdown(); await b?.cleanup(); });
import { load as matter } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/matter/+page.server.ts';
import { load as timeline } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/timeline/+page.server.ts';
import { load as contradictions_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/contradictions_tab/+page.server.ts';
import { load as risk_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/risk_matrix_tab/+page.server.ts';
import { load as vdm_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/vdm_matrix_tab/+page.server.ts';
import { load as witness_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/witness_tab/+page.server.ts';
import { load as people } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/people/+page.server.ts';
import { load as entity_ledger_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/entity_ledger_tab/+page.server.ts';
import { load as conflict_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/conflict_tab/+page.server.ts';
const routes = [
  ['analysis/matter', matter],
  ['analysis/timeline', timeline],
  ['analysis/contradictions_tab', contradictions_tab],
  ['analysis/risk_matrix_tab', risk_matrix_tab],
  ['analysis/vdm_matrix_tab', vdm_matrix_tab],
  ['analysis/witness_tab', witness_tab],
  ['evidence/people', people],
  ['evidence/entity_ledger_tab', entity_ledger_tab],
  ['litigation/conflict_tab', conflict_tab],] as const;
test.each(routes)('%s shard props equal the unchanged local loader', async (route, load) => {
  const local = await localLoad({ store: lc.store, resultsVersion: b.synth.resultsVersion }, route);
  const hosted = await load({ locals: locals(dep), params: { caseId: CASE_ID, version: b.synth.resultsVersion } as never });
  const { base, empty, ...props } = hosted;
  expect(base).toBe(`/cases/${CASE_ID}/v`);
  expect(empty).toBe(false);
  // JSON is the actual shard wire format: prove its bytes match the local output first.
  const bytes = b.files.get(`view/${route.split('/').at(-1)}.json`)!;
  expect(bytes).toEqual(new TextEncoder().encode(JSON.stringify(local)));
  expect(props).toStrictEqual(JSON.parse(new TextDecoder().decode(bytes)));
});

test('matter title and contradiction summary remain content without narrative/items', async () => {
  for (const populated of [true, false]) {
    // These synthetic edge payloads go through the real signed publication path before the route reads them.
    const out = path.join(b.root, populated ? 'summary' : 'missing');
    const files = new Map(b.files);
    const original = JSON.parse(new TextDecoder().decode(files.get('view/contradictions_tab.json')!));
    const values = {
      matter: { matter: populated ? { title: 'Synthetic matter summary', storyline: [], strategy: [] } : null, known: [] },
      contradictions_tab: { ...original, c: populated ? { ...original.c, categories: [] } : null },
    };
    for (const [id, value] of Object.entries(values)) files.set(`view/${id}.json`, new TextEncoder().encode(JSON.stringify(value)));
    const manifest = shardManifest(b.built.manifest, [...files].filter(([name]) => name !== 'manifest.json').map(([name, bytes]) => ({ name, bytes })));
    files.set('manifest.json', manifest.bytes);
    for (const [name, bytes] of files) {
      const file = path.join(out, 'shards', name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    }
    const built = { ...b.built, manifest: manifest.manifest, manifestSha256: manifest.sha256, record: { ...b.built.record, shardManifestSha256: manifest.sha256 } };
    const edge = await published({ ...b, out, built, files });
    const event = () => ({ locals: locals(edge), params: { caseId: CASE_ID, version: b.synth.resultsVersion } as never });
    expect((await matter(event())).empty).toBe(!populated);
    expect((await contradictions_tab(event())).empty).toBe(!populated);
  }
});
