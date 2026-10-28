// Sprint ticket 06: `register` writes rows the hosted reader verifies, `signoff` binds the shard manifest and names every
// warning, and `publish` flips rs_publication only for a manifest a sign-off binds, keeping the previous version.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadVerifiedModel } from '../../../src/lib/results/hosted/model.ts';
import { publicationRow } from '../../../src/lib/results/hosted/versions.ts';
import { publish, register } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
import type { BuildRecord } from '../../../scripts/publish/types.ts';
import { sha256Hex } from '../../../scripts/publish/manifest.ts';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';
import { acksFor, builtCase, missing, CASE_ID, caseId, client, locals, published, SIGNER, type BuiltCase } from './world.ts';

const AT = '2001-01-01T00:00:00.000Z';
let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());
const manifest = () => b.files.get('manifest.json')!;
const count = (dep: ReturnType<typeof client>, sql: string) => Object.values(dep.db.sqlite.prepare(sql).get() as Record<string, number>)[0];

describe('06 register', () => {
  test('stores the version with rows that reproduce its read-model digest, and writes no package, candidate or evidence rows', async () => {
    const dep = client(), r = b.built.record;
    await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    const v = dep.db.sqlite.prepare('SELECT state, import_seq, expected_files, package_bytes FROM rs_results_version WHERE version_id = ?').get(r.resultsVersion) as Record<string, unknown>;
    expect(v).toMatchObject({ state: 'stored', import_seq: 1, expected_files: r.version.expect.files, package_bytes: r.version.packageBytes });
    const model = await loadVerifiedModel(dep.db, r.resultsVersion);
    expect(model.docs.length).toBe(r.version.expect.documents);
    expect(count(dep, 'SELECT COUNT(*) FROM rs_package_file')).toBe(0);
    expect(count(dep, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'pub_candidate%'")).toBe(0);
    expect(dep.db.sqlite.prepare('SELECT prefix, manifest_sha256 FROM rs_shard_manifest').all()).toEqual([{ prefix: `views/${r.resultsVersion.slice(7)}/`, manifest_sha256: r.shardManifestSha256 }]);
  });

  test('refuses a package converted against a partial case folder beyond the acknowledged count', async () => {
    const dep = client(), r = b.built.record, n = missing(b.built);
    expect(n).toBeGreaterThan(0);
    await expect(register(dep.d1, r, { at: AT, acknowledgedMissing: n - 1, manifest: manifest() })).rejects.toThrow(/partial case folder/);
    expect(count(dep, 'SELECT COUNT(*) FROM rs_results_version')).toBe(0);
    await register(dep.d1, r, { at: AT, acknowledgedMissing: n, manifest: manifest() });
  });
});

describe('06 signoff', () => {
  test('refuses an unacknowledged warning, an acknowledgement of something else, a reasonless one and a non-email signer', async () => {
    const dep = client(), r = b.built.record;
    await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    const acks = acksFor(b.built);
    expect(acks.length).toBeGreaterThan(0);
    await expect(signoff(dep.d1, r, { signer: SIGNER, acks: acks.slice(1), at: AT })).rejects.toThrow(/is not acknowledged/);
    await expect(signoff(dep.d1, r, { signer: SIGNER, acks: [...acks, 'DIAG_TRUNCATED=no'], at: AT })).rejects.toThrow(/not a warning of this build/);
    await expect(signoff(dep.d1, r, { signer: SIGNER, acks: acks.map((a) => a.split('=')[0]!), at: AT })).rejects.toThrow(/no reason/);
    await expect(signoff(dep.d1, r, { signer: 'nobody', acks, at: AT })).rejects.toThrow(/email/);
    expect(count(dep, 'SELECT COUNT(*) FROM pub_shard_signoff')).toBe(0);
  });

  test('refuses before register, and binds the shard manifest with each warning code, count and reason', async () => {
    const dep = client(), r = b.built.record;
    await expect(signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT })).rejects.toThrow(/register first/);
    await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    const { acknowledgements: acks } = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    const row = dep.db.sqlite.prepare('SELECT shard_manifest_sha256, acknowledgements_json, signer FROM pub_shard_signoff').get() as Record<string, string>;
    expect(row.shard_manifest_sha256).toBe(r.shardManifestSha256);
    expect(JSON.parse(row.acknowledgements_json)).toEqual(acks);
    expect(acks.every((a) => a.count === r.diagnostics[a.code] && a.reason === 'synthetic fixture')).toBe(true);
    expect(() => dep.db.sqlite.exec('UPDATE pub_shard_signoff SET signer = \'x@y.z\'')).toThrow();
    expect(() => dep.db.sqlite.exec('DELETE FROM pub_shard_signoff')).toThrow();
  });
});

describe('06 publish', () => {
  test('refuses without a sign-off, and when R2 holds another manifest or none', async () => {
    const dep = client(), r = b.built.record;
    await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    await expect(publish(dep.d1, r, { remoteManifest: manifest(), at: AT })).rejects.toThrow(/no sign-off binds/);
    await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    await expect(publish(dep.d1, r, { remoteManifest: new TextEncoder().encode('{}'), at: AT })).rejects.toThrow(/not the one this build wrote/);
    await expect(publish(dep.d1, r, { remoteManifest: null, at: AT })).rejects.toThrow(/upload first/);
    expect(count(dep, 'SELECT COUNT(*) FROM rs_publication')).toBe(0);
  });

  test('flips the publication in one statement; the hosted reader serves it; a later version keeps the previous one', async () => {
    const dep = await published(b), r = b.built.record;
    const first = await publicationRow(dep.db, caseId);
    expect(first).toEqual({ versionId: r.resultsVersion, publishedAt: AT, previousVersionId: null, shardManifestSha256: r.shardManifestSha256, shards: Object.fromEntries(b.built.manifest.shards.map((x) => [x.name, x.bytes])) });
    expect(await locals(dep).store.publication({ caseId })).toEqual(first);

    // Publishing the same version again changes nothing.
    await publish(dep.d1, r, { remoteManifest: manifest(), at: '2001-02-02T00:00:00.000Z' });
    expect(await publicationRow(dep.db, caseId)).toEqual(first);

    // A second version (same rows under another id) takes over and keeps the first as previous.
    const rv2 = `sha256:${'2'.repeat(64)}`;
    const m2 = new TextEncoder().encode(canonicalJson({ ...JSON.parse(new TextDecoder().decode(manifest())), resultsVersion: rv2 }));
    const r2: BuildRecord = { ...r, resultsVersion: rv2, shardManifestSha256: sha256Hex(m2) };
    await register(dep.d1, r2, { at: AT, acknowledgedMissing: missing(b.built), manifest: m2 });
    await signoff(dep.d1, r2, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    await publish(dep.d1, r2, { remoteManifest: m2, at: '2001-03-03T00:00:00.000Z' });
    expect(await publicationRow(dep.db, caseId)).toEqual({ versionId: rv2, publishedAt: '2001-03-03T00:00:00.000Z', previousVersionId: r.resultsVersion, shardManifestSha256: r2.shardManifestSha256, shards: first?.shards });
    expect(dep.db.sqlite.prepare('SELECT import_seq FROM rs_results_version ORDER BY import_seq').all()).toEqual([{ import_seq: 1 }, { import_seq: 2 }]);
  });

  test('a rebuilt manifest replaces the registered one only while the version is unpublished', async () => {
    const rebuilt = new TextEncoder().encode(canonicalJson({ ...JSON.parse(new TextDecoder().decode(manifest())), builtAt: '2001-09-09T00:00:00.000Z' }));
    const r = b.built.record, r2: BuildRecord = { ...r, shardManifestSha256: sha256Hex(rebuilt) };
    const unpublished = client();
    await register(unpublished.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifest() });
    await register(unpublished.d1, r2, { at: AT, acknowledgedMissing: missing(b.built), manifest: rebuilt });
    expect(unpublished.db.sqlite.prepare('SELECT manifest_sha256 FROM rs_shard_manifest').all()).toEqual([{ manifest_sha256: r2.shardManifestSha256 }]);
    const dep = await published(b);
    await expect(register(dep.d1, r2, { at: AT, acknowledgedMissing: missing(b.built), manifest: rebuilt })).rejects.toThrow(/published with another shard manifest/);
    expect((await publicationRow(dep.db, caseId))?.shardManifestSha256).toBe(r.shardManifestSha256);
    expect(count(dep, `SELECT COUNT(*) FROM rs_shard_entry WHERE manifest_sha256 = '${r2.shardManifestSha256}'`)).toBe(0);
    expect(() => dep.db.sqlite.exec(`UPDATE rs_shard_manifest SET manifest_sha256 = '${r2.shardManifestSha256}'`)).toThrow(/never replaced/);
    expect(CASE_ID).toBe(r.caseId);
  });
});
