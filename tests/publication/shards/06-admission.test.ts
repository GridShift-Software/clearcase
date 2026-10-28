// Sprint ticket 06, review finding H1: the signed publication governs what is served. A version serves only the shards its
// admitted manifests name (the signed manifest.json, then each signed and published amendment); upload never replaces an
// object R2 holds; adding a family to a published version is an appended amendment with its own sign-off.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildFamily, shardsOut } from '../../../scripts/publish/build.ts';
import { MANIFEST_NAME, shardAmendment, shardManifest } from '../../../scripts/publish/manifest.ts';
import { amend, publishAmendment } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
import type { ShardModule } from '../../../scripts/publish/types.ts';
import { upload } from '../../../scripts/publish/upload.ts';
import { shardPrefix, type ShardBucket, type ShardCache } from '../../../src/lib/results/hosted/shards.ts';
import { publicationRow } from '../../../src/lib/results/hosted/versions.ts';
import { memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import type { PayloadManifest } from '../../../src/lib/views/payloads/manifest.ts';
import { shard } from '../../../src/lib/views/hosted/payloads.server.ts';
import { acksFor, AT, builtCase, CASE_ID, caseId, client, locals, memoryRemote, published, SIGNER, type BuiltCase, type Deployment } from './world.ts';

const FAMILY = 'synthetic-extra', EXTRA_NAME = 'view/synthetic_extra.json';
const EXTRA: ShardModule = { name: FAMILY, async build({ json, resultsVersion }) { return [json(EXTRA_NAME, { syntheticExtra: true, resultsVersion })]; } };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());
const rv = () => b.built.record.resultsVersion;
const params = () => ({ caseId: CASE_ID, version: rv() });
const key = (name: string) => shardPrefix(rv()) + name;
const snapshot = (dep: Deployment) => new Map([...dep.bucket.objects].map(([k, v]) => [k, sha(v)]));
const family = () => buildFamily({ packageDir: b.synth.pkgDir, caseFolder: b.synth.caseDir, caseId: CASE_ID, out: b.out, family: FAMILY, modules: [EXTRA], builder: { sha: 'test', bun: 'test' } });

/** The shard reader's two stores, counting what a read touches. */
function counted(dep: Deployment) {
  const n = { match: 0, get: 0 }, cache = memoryShardCache();
  const c: ShardCache = { match: (k) => { n.match++; return cache.match(k); }, put: (k, r) => cache.put(k, r) };
  const bucket: ShardBucket = { get: (k) => { n.get++; return dep.bucket.get(k); } };
  return { n, cache, l: locals(dep, { cache: c, bucket }) };
}
async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try { await p; return 'ok'; } catch (e) { const s = (e as { status?: number }).status; if (typeof s === 'number') return s; throw e; }
}

describe('06 admitted shards', () => {
  test('a shard R2 holds that no admitted manifest names is refused before the cache lookup and the R2 read', async () => {
    const dep = await published(b);
    dep.bucket.objects.set(key('view/new-family.json'), enc('{"syntheticUnsigned":true}'));
    const { n, l } = counted(dep);
    expect(await status(shard(l, params(), 'view/new-family.json'))).toBe(404);
    expect(n).toEqual({ match: 0, get: 0 });
    expect(await shard(l, params(), 'overview.json')).toMatchObject({ documents: { total: b.built.manifest.counts.documents } });
  });

  test('the publication row carries the admitted names with their bytes: exactly the signed manifest', async () => {
    const dep = await published(b);
    const p = await publicationRow(dep.db, caseId);
    expect(p?.shards).toEqual(Object.fromEntries(b.built.manifest.shards.map((s) => [s.name, s.bytes])));
  });

  test('an admitted shard whose stored object has other bytes than its entry is a storage fault and is not cached', async () => {
    const dep = await published(b);
    dep.bucket.objects.set(key('overview.json'), enc('{"replaced":true}'));
    const { cache, l } = counted(dep);
    expect(await status(shard(l, params(), 'overview.json'))).toBe(503);
    expect(cache.entries.size).toBe(0);
  });
});

describe('06 amendments', () => {
  test('a family added to the published version is served once its amendment is signed and published; the original manifest is unchanged', async () => {
    const dep = await published(b), r = b.built.record;
    const before = { manifest: dep.bucket.objects.get(key(MANIFEST_NAME))!, row: await publicationRow(dep.db, caseId), signoffs: dep.db.sqlite.prepare('SELECT * FROM pub_shard_signoff').all() };

    const fam = await family();
    const extra = new Uint8Array(await readFile(path.join(shardsOut(b.out), EXTRA_NAME)));
    expect(fam.amendment).toEqual({ format: 'clearcase.shard-amendment/1', caseId: CASE_ID, resultsVersion: rv(), parentManifestSha256: r.shardManifestSha256, family: FAMILY,
      shards: [{ name: EXTRA_NAME, bytes: extra.byteLength, sha256: sha(extra) }] });
    expect([fam.sha256, fam.name]).toEqual([sha(fam.bytes), `amendments/${sha(fam.bytes)}.json`]);

    const remote = memoryRemote(dep.bucket.objects, rv());
    await upload({ dir: shardsOut(b.out), index: fam.name, remote });
    expect(remote.created).toEqual([EXTRA_NAME, fam.name]);
    const { l } = counted(dep);
    expect(await status(shard(l, params(), EXTRA_NAME))).toBe(404);

    await amend(dep.d1, r, fam.bytes, { at: AT });
    await expect(publishAmendment(dep.d1, r, { amendment: fam.bytes, remote: await remote.read(fam.name), at: AT })).rejects.toThrow(/sign-off/);
    expect(await status(shard(counted(dep).l, params(), EXTRA_NAME))).toBe(404);

    await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT, target: fam.sha256 });
    await expect(publishAmendment(dep.d1, r, { amendment: fam.bytes, remote: enc('{}'), at: AT })).rejects.toThrow(/not the one this build wrote/);
    await publishAmendment(dep.d1, r, { amendment: fam.bytes, remote: await remote.read(fam.name), at: AT });
    await publishAmendment(dep.d1, r, { amendment: fam.bytes, remote: await remote.read(fam.name), at: '2001-02-02T00:00:00.000Z' });
    expect(await shard(counted(dep).l, params(), EXTRA_NAME)).toEqual({ syntheticExtra: true, resultsVersion: rv() });

    const after = await publicationRow(dep.db, caseId);
    expect(dep.bucket.objects.get(key(MANIFEST_NAME))).toEqual(before.manifest);
    expect(sha(dep.bucket.objects.get(key(MANIFEST_NAME))!)).toBe(r.shardManifestSha256);
    expect({ ...after, shards: null }).toEqual({ ...before.row, shards: null });
    expect(after?.shards).toEqual({ ...before.row?.shards, [EXTRA_NAME]: extra.byteLength });
    expect(dep.db.sqlite.prepare('SELECT * FROM pub_shard_signoff WHERE shard_manifest_sha256 = ?').all(r.shardManifestSha256)).toEqual(before.signoffs);
  });

  test('build --family refuses a family whose shards the signed manifest already names', async () => {
    await expect(buildFamily({ packageDir: b.synth.pkgDir, caseFolder: b.synth.caseDir, caseId: CASE_ID, out: b.out, family: 'shell' })).rejects.toThrow(/already in the version's manifest/);
    await expect(buildFamily({ packageDir: b.synth.pkgDir, caseFolder: b.synth.caseDir, caseId: CASE_ID, out: b.out, family: 'no-such-family' })).rejects.toThrow(/no shard module/);
  });

  test('two amendments naming the same shard: the first published is admitted, the second is refused', async () => {
    const dep = await published(b), r = b.built.record;
    const one = (text: string) => shardAmendment({ caseId: CASE_ID, resultsVersion: rv(), parentManifestSha256: r.shardManifestSha256, family: FAMILY }, [{ name: EXTRA_NAME, bytes: enc(text) }]);
    const a = one('{"a":1}'), c = one('{"c":22}');
    for (const x of [a, c]) {
      await amend(dep.d1, r, x.bytes, { at: AT });
      await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT, target: x.sha256 });
    }
    await publishAmendment(dep.d1, r, { amendment: a.bytes, remote: a.bytes, at: AT });
    await expect(publishAmendment(dep.d1, r, { amendment: c.bytes, remote: c.bytes, at: AT })).rejects.toThrow(/already admitted/);
    await expect(amend(dep.d1, r, one('{"d":333}').bytes, { at: AT })).rejects.toThrow(/already admitted/);
    expect((await publicationRow(dep.db, caseId))?.shards?.[EXTRA_NAME]).toBe(enc('{"a":1}').byteLength);
  });

  test('an amendment of a version whose manifest is not published is refused', async () => {
    const dep = client(), r = b.built.record;
    const x = shardAmendment({ caseId: CASE_ID, resultsVersion: rv(), parentManifestSha256: r.shardManifestSha256, family: FAMILY }, [{ name: EXTRA_NAME, bytes: enc('{}') }]);
    await expect(amend(dep.d1, r, x.bytes, { at: AT })).rejects.toThrow(/not published/);
  });
});

describe('06 upload', () => {
  test('refuses a changed existing shard before writing anything, and never replaces manifest.json', async () => {
    const dep = await published(b);
    const dir = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-rebuilt-'));
    try {
      await cp(shardsOut(b.out), dir, { recursive: true });
      // A rebuild whose shell differs: its own manifest lists it correctly, so only R2 can tell.
      await writeFile(path.join(dir, 'shell.json'), enc(`${new TextDecoder().decode(b.files.get('shell.json')!)} `));
      await writeFile(path.join(dir, 'view-new.json'), enc('{"new":true}'));
      const m = JSON.parse(new TextDecoder().decode(b.files.get(MANIFEST_NAME)!)) as PayloadManifest;
      const shards = await Promise.all([...m.shards.map((s) => s.name), 'view-new.json'].map(async (name) => ({ name, bytes: new Uint8Array(await readFile(path.join(dir, name))) })));
      const { format: _f, shards: _s, ...meta } = m;
      await writeFile(path.join(dir, MANIFEST_NAME), shardManifest({ ...meta, builtAt: '2001-09-09T00:00:00.000Z' }, shards).bytes);
      const before = snapshot(dep), remote = memoryRemote(dep.bucket.objects, rv());
      await expect(upload({ dir, index: MANIFEST_NAME, remote })).rejects.toThrow(/shell\.json.*manifest\.json|manifest\.json.*shell\.json/s);
      expect([snapshot(dep), remote.created]).toEqual([before, []]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('refuses local files that are not the bytes their manifest lists', async () => {
    const dep = await published(b);
    const dir = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-tampered-'));
    try {
      await cp(shardsOut(b.out), dir, { recursive: true });
      await writeFile(path.join(dir, 'overview.json'), enc('{}'));
      const remote = memoryRemote(dep.bucket.objects, rv());
      await expect(upload({ dir, index: MANIFEST_NAME, remote })).rejects.toThrow(/overview\.json is not the file manifest\.json lists/);
      expect(remote.created).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('an amendment whose new shard R2 already holds with other bytes is refused, and its amendment file is not written', async () => {
    const dep = await published(b);
    const fam = await family();
    dep.bucket.objects.set(key(EXTRA_NAME), enc('{"stray":true}'));
    const remote = memoryRemote(dep.bucket.objects, rv());
    await expect(upload({ dir: shardsOut(b.out), index: fam.name, remote })).rejects.toThrow(/view\/synthetic_extra\.json/);
    expect(dep.bucket.objects.has(key(fam.name))).toBe(false);
  });
});
