import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../../../../../../../../scripts/fixtures/synthetic/corpus.ts';
import { sha256Hex } from '../../../../../../../../src/lib/case-package/hash.ts';
import { CASE, OLD_RV, RV, event, fake, outcome } from '../../../../../../../../tests/hosted-smoke/case-overview/doubles.ts';
import { load } from './+page.server.ts';

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
const request = (f: ReturnType<typeof setup>, key: string, version = RV, caseId = CASE) => outcome(load(event(f.services, { caseId, resultsVersion: version, key })));
describe('records route', () => {
  it('opens every registered dataset for a published reader', async () => {
    for (const key of keys) {
      const r = await request(setup(), key);
      expect(r, key).toHaveProperty('value');
      if ('value' in r) expect(r.value.html).toContain('Source records');
    }
  }, 120_000);
  it('refuses a candidate and another case before loading data', async () => {
    const f = setup();
    expect(await request(f, keys[0]!, OLD_RV)).toMatchObject({ thrown: { status: 403 } });
    const other = setup();
    expect(await request(other, keys[0]!, RV, 'other-case')).toMatchObject({ thrown: { status: 404 } });
  });
});
