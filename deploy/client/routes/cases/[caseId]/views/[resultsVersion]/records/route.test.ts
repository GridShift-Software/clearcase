import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../../../../../../../../scripts/fixtures/synthetic/corpus.ts';
import { sha256Hex } from '../../../../../../../../src/lib/case-package/hash.ts';
import { CASE, OLD_RV, RV, event, fake, outcome } from '../../../../../../../../tests/hosted-smoke/case-overview/doubles.ts';
import { load } from './[key]/+page.server.ts';
import { createCloudResults } from '../../../../../../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../../../../../../src/lib/storage/cloud/staging.ts';
import { id } from '../../../../../../../../src/lib/server/runtime/ids.ts';
import { BUDGETS, QUOTAS, deployment, grantedIdentity, ids, provideOriginals, publish, syntheticPackage } from '../../../../../../../../tests/hosted-foundation/storage/fixture.ts';

let root: string;
let files: Map<string, Uint8Array>;
let keys: string[];
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'records-route-'));
  await generateCorpus({ out: path.join(root, 'corpus'), seed: 'route-test', documents: 24, profile: 'poc' });
  const pkg = path.join(root, 'corpus', 'pkg');
  const manifest = JSON.parse(await readFile(path.join(pkg, 'manifest.json'), 'utf8'));
  manifest.case.id = CASE; manifest.resultsVersion = RV;
  const mb = new TextEncoder().encode(JSON.stringify(manifest));
  files = new Map([['manifest.json', mb]]);
  for (const entry of manifest.files) files.set(entry.path, await readFile(path.join(pkg, entry.path)));
  keys = manifest.files.filter((f: { role: string }) => f.role === 'dataset').map((f: { key: string }) => f.key);
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function setup() {
  const f = fake({ publication: { kind: 'published', resultsVersion: RV } });
  const original = f.services.store;
  f.services.store = new Proxy(original, { get(target, key, receiver) {
    if (key === 'getVersion') return async () => ({ id: RV, case_id: CASE, manifest_sha256: sha256Hex(files.get('manifest.json')!) });
    if (key === 'packageFile') return async ({ path: p }: { path: string }) => files.get(p) ?? null;
    return Reflect.get(target, key, receiver);
  } });
  return f;
}
const request = (f: ReturnType<typeof setup>, key: string, version = RV, caseId: string = CASE) => outcome(load(event(f.services, { caseId, resultsVersion: version, key })));
describe('records route', () => {
  it('reads a published dataset through the actual hosted reader and refuses an unassigned case', async () => {
    const dep = deployment('client-a', ['case-a', 'case-b']);
    const who = grantedIdentity(ids.clientA, ['case-a']);
    const options = { bindings: dep, clientId: ids.clientA, budgets: BUDGETS, identity: who.identity, record: async () => {}, stateRevision: async () => id('case-revision', 'r1'), now: () => new Date('2001-01-01T00:00:00Z') };
    const pkg = await syntheticPackage('case-a', 'records-route');
    await provideOriginals(dep, 'case-a', pkg);
    const staging = createResultsStaging({ ...options, quotas: QUOTAS, authorize: async () => {} });
    expect(await staging.stage({ caseId: ids.caseA, operationId: 'records-import', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection })).toMatchObject({ kind: 'stored' });
    publish(dep.db, 'case-a', pkg.identity.resultsVersion);
    const services = { ...fake({ publication: { kind: 'none' } }).services, ...createCloudResults(options), identity: who.identity };
    const response = await outcome(load(event(services, { caseId: 'case-a', resultsVersion: pkg.identity.resultsVersion, key: 'chronology' })));
    expect(response).toHaveProperty('value');
    expect(await outcome(load(event(services, { caseId: 'case-b', resultsVersion: pkg.identity.resultsVersion, key: 'chronology' })))).toMatchObject({ thrown: { status: 404 } });
  });
  it('opens every registered dataset for a published reader', async () => {
    for (const key of keys) {
      const r = await request(setup(), key);
      expect(r, key).toHaveProperty('value');
      if ('value' in r) expect(r.value.html).toContain('Source records');
    }
  }, 120_000);
  it('uses the published original attribution for a cited page and refuses changed dataset bytes', async () => {
    const originalManifest = files.get('manifest.json')!, originalMatter = files.get('datasets/matter.json')!;
    try {
      const manifest = JSON.parse(new TextDecoder().decode(originalManifest));
      const matter = JSON.parse(new TextDecoder().decode(originalMatter));
      matter.data.title = 'Evidence [[DOC-001#p2]]';
      const bytes = new TextEncoder().encode(JSON.stringify(matter));
      const entry = manifest.files.find((f: { key?: string }) => f.key === 'matter');
      entry.sha256 = sha256Hex(bytes); entry.size = bytes.length;
      files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
      files.set('datasets/matter.json', bytes);
      const result = await request(setup(), 'matter');
      expect(result).toHaveProperty('value');
      if ('value' in result) expect(result.value.html).toContain(`href="/cases/${CASE}/originals/DOC-001/view?page=2"`);
      files.set('datasets/matter.json', new TextEncoder().encode('corrupt'));
      expect(await request(setup(), 'matter')).toMatchObject({ thrown: { status: 503 } });
    } finally { files.set('manifest.json', originalManifest); files.set('datasets/matter.json', originalMatter); }
  });
  it('refuses a candidate and another case before loading data', async () => {
    const f = setup();
    expect(await request(f, keys[0]!, OLD_RV)).toMatchObject({ thrown: { status: 403 } });
    const other = setup();
    expect(await request(other, keys[0]!, RV, 'other-case')).toMatchObject({ thrown: { status: 404 } });
  });
});
