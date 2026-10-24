// GRS-115: hosted D1 results and protected R2 originals, through the CaseReader and AssetsAccess contracts.
// UNIT evidence only: D1 and R2 are the test doubles in ./doubles.ts, not Cloudflare. The real-boundary legs (local
// workerd and the deployed client) belong to the integration owner.
import { describe, expect, it } from 'vitest';
import { createCloudResults, type StorageEvent } from '../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { storageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';
import { id, resultsVersion, type CaseRevision } from '../../../src/lib/server/runtime/ids.ts';
import type { AssetRef } from '../../../src/lib/server/runtime/contracts.ts';
import { BUDGETS, GET, deployment, grantedIdentity, ids, pdf, publish, shaOf, syntheticPackage, withdraw } from './fixture.ts';
import type { MemoryR2, SqliteD1 } from './doubles.ts';

const now = () => new Date('2001-01-01T00:00:00Z');
type Dep = { db: SqliteD1; bucket: MemoryR2 };

function world(a: { dep?: Dep; budgets?: typeof BUDGETS | null; grants?: string[] } = {}) {
  const dep = a.dep ?? deployment('client-a', ['case-a', 'case-b']);
  const bindings = { db: dep.db, bucket: dep.bucket };
  const budgets = a.budgets === undefined ? BUDGETS : a.budgets;
  const who = grantedIdentity(ids.clientA, a.grants ?? ['case-a']);
  const events: StorageEvent[] = [];
  const results = createCloudResults({
    bindings, clientId: ids.clientA, budgets, identity: who.identity,
    record: async (e) => { events.push(e); },
    stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision,
  });
  const staging = createResultsStaging({ bindings, clientId: ids.clientA, budgets, now });
  const intake = createOriginalIntake({ bindings, clientId: ids.clientA, budgets, now });
  return { ...dep, ...results, staging, intake, who, events };
}

async function upload(w: ReturnType<typeof world>, assetId: string, bytes: Uint8Array, operationId = `op-${assetId}`) {
  const caseId = ids.caseA;
  expect(await w.intake.declare({ caseId, operationId, assetId, filename: `${assetId}.pdf`, mediaType: 'application/pdf', size: bytes.byteLength, sha256: shaOf(bytes) })).toMatchObject({ kind: 'declared' });
  expect(await w.intake.put({ caseId, operationId, bytes })).toMatchObject({ kind: 'stored' });
  return w.intake.finalize({ caseId, operationId });
}
const original = (assetId: string): AssetRef => ({ kind: 'original', caseId: ids.caseA, assetId });
async function stage(w: ReturnType<typeof world>, pkg: Awaited<ReturnType<typeof syntheticPackage>>, over: Partial<Parameters<ReturnType<typeof createResultsStaging>['stage']>[0]> = {}) {
  return w.staging.stage({ caseId: ids.caseA, operationId: 'import-1', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection, ...over });
}

describe('hosted originals (R2, verify on load)', () => {
  it('refuses a corrupt original with no byte released and records the failure, not a delivery', async () => {
    const w = world(), bytes = pdf('corrupt');
    expect(await upload(w, 'a1', bytes)).toMatchObject({ kind: 'finalized', repeated: false });
    w.bucket.tamper(`orig/${shaOf(bytes)}`, (b) => { b[b.length - 2]! ^= 1; return b; });
    await expect(w.assets.get({ asset: original('a1'), request: GET })).rejects.toMatchObject({ code: 'changed-original' });
    await expect(w.assets.get({ asset: original('a1'), request: { ...GET, range: 'bytes=0-3' } })).rejects.toMatchObject({ code: 'changed-original' });
    expect(await w.assets.availability({ asset: original('a1') })).toEqual({ kind: 'unavailable', reason: 'changed', parent: null });
    expect(w.events.map((e) => e.outcome)).toEqual(['failed', 'failed']);
  });

  it('refuses a truncated original by its recorded size and a deleted one as missing', async () => {
    const w = world(), bytes = pdf('trunc');
    await upload(w, 'a1', bytes);
    w.bucket.tamper(`orig/${shaOf(bytes)}`, (b) => b.slice(0, 5));
    await expect(w.assets.get({ asset: original('a1'), request: GET })).rejects.toMatchObject({ code: 'changed-original' });
    w.bucket.objects.delete(`orig/${shaOf(bytes)}`);
    await expect(w.assets.get({ asset: original('a1'), request: GET })).rejects.toMatchObject({ code: 'missing-original' });
  });

  it('serves an original through the case grant before any publication: exact bytes, HEAD, one range, refused ranges', async () => {
    const w = world(), bytes = pdf('serve');
    await upload(w, 'a1', bytes);
    expect(await w.assets.originals({ caseId: ids.caseA })).toEqual([{ assetId: 'a1', filename: 'a1.pdf', mediaType: 'application/pdf', size: bytes.byteLength }]);
    const whole = await w.assets.get({ asset: original('a1'), request: GET });
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
    expect(whole.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(whole.headers.get('content-security-policy')).toContain('sandbox');
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
    const head = await w.assets.get({ asset: original('a1'), request: { ...GET, method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const part = await w.assets.get({ asset: original('a1'), request: { ...GET, range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(2, 6));
    const suffix = await w.assets.get({ asset: original('a1'), request: { ...GET, range: 'bytes=-4' } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-4));
    for (const range of ['bytes=0-1,4-5', `bytes=${bytes.byteLength}-`, 'bytes=5-2', 'items=0-1']) {
      const r = await w.assets.get({ asset: original('a1'), request: { ...GET, range } });
      expect(r.status, range).toBe(416);
      expect(r.body, range).toBeNull();
    }
    const stale = await w.assets.get({ asset: original('a1'), request: { ...GET, range: 'bytes=0-1', ifRange: '"other"' } });
    expect(stale.status).toBe(200);
    expect(w.events.filter((e) => e.outcome === 'succeeded').length).toBe(5);
  });

  it('releases nothing when the grant is revoked while the object is read', async () => {
    const w = world(), bytes = pdf('revoke');
    await upload(w, 'a1', bytes);
    const get = w.bucket.get.bind(w.bucket);
    w.bucket.get = async (key) => { const o = await get(key); if (key.startsWith('orig/')) w.who.grants.delete('case-a'); return o; };
    await expect(w.assets.get({ asset: original('a1'), request: GET })).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.events.map((e) => e.outcome)).toEqual(['denied']);
  });

  it('refuses another case’s original and an unknown asset without naming either', async () => {
    const w = world({ grants: ['case-a'] }), bytes = pdf('other');
    await upload(w, 'a1', bytes);
    await expect(w.assets.get({ asset: { ...original('a1'), caseId: ids.caseB }, request: GET })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.assets.get({ asset: original('nope'), request: GET })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('never re-binds an asset id to another original and never overwrites a stored original', async () => {
    const w = world(), first = pdf('first'), second = pdf('second');
    await upload(w, 'a1', first);
    expect(await upload(w, 'a1', first, 'op-repeat')).toMatchObject({ kind: 'finalized', repeated: true });
    expect(await upload(w, 'a1', second, 'op-rebind')).toEqual({ kind: 'refused', reason: 'asset-bound-to-another-original' });
    // Other bytes already under an original's key (a credential holder's write) are a conflict, never replaced.
    const third = pdf('third');
    w.bucket.setRaw(`orig/${shaOf(third)}`, pdf('not third'));
    await w.intake.declare({ caseId: ids.caseA, operationId: 'op-3', assetId: 'a3', filename: 'a3.pdf', mediaType: 'application/pdf', size: third.byteLength, sha256: shaOf(third) });
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-3', bytes: third })).toEqual({ kind: 'refused', reason: 'conflicting-object' });
    expect(new TextDecoder().decode(w.bucket.objects.get(`orig/${shaOf(third)}`)!.bytes)).toContain('not third');
    expect(await w.intake.finalize({ caseId: ids.caseA, operationId: 'op-3' })).toEqual({ kind: 'refused', reason: 'digest-mismatch' });
    // Bytes that are not the declared ones are refused before any write.
    await w.intake.declare({ caseId: ids.caseA, operationId: 'op-4', assetId: 'a4', filename: 'a4.pdf', mediaType: 'application/pdf', size: first.byteLength, sha256: shaOf(first) });
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-4', bytes: second })).toEqual({ kind: 'refused', reason: 'digest-mismatch' });
    const served = await w.assets.get({ asset: original('a1'), request: GET });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(first);
  });
});

describe('client isolation and budgets', () => {
  it('refuses every read and write when the deployment is bound to another client’s database or bucket', async () => {
    const b = deployment('client-b', ['case-a']), a = deployment('client-a', ['case-a']);
    for (const dep of [b, { db: a.db, bucket: b.bucket }, { db: b.db, bucket: a.bucket }]) {
      const w = world({ dep });
      await expect(w.store.listCases()).rejects.toMatchObject({ code: 'storage-unavailable' });
      await expect(w.store.getCase({ caseId: ids.caseA })).rejects.toMatchObject({ code: 'storage-unavailable' });
      await expect(w.assets.originals({ caseId: ids.caseA })).rejects.toMatchObject({ code: 'asset-unavailable' });
      await expect(w.intake.declare({ caseId: ids.caseA, operationId: 'x', assetId: 'a', filename: 'a.pdf', mediaType: 'application/pdf', size: 1, sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'storage-unavailable' });
      const pkg = await syntheticPackage('case-a', 'crossed');
      await expect(stage(w, pkg)).rejects.toMatchObject({ code: 'storage-unavailable' });
    }
    expect(b.db.rows('SELECT * FROM rs_original_upload')).toEqual([]);
    expect([...b.bucket.objects.keys()]).toEqual(['identity/client.json']);
  });

  it('fails closed without budgets and refuses an original over the buffered budget', async () => {
    const none = world({ budgets: null });
    await expect(none.store.listCases()).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(none.assets.originals({ caseId: ids.caseA })).rejects.toMatchObject({ code: 'asset-unavailable' });
    const dep = deployment('client-a', ['case-a']), bytes = pdf('big');
    await upload(world({ dep }), 'a1', bytes);
    const small = world({ dep, budgets: { ...BUDGETS, maxBufferedObjectBytes: 8 } });
    await expect(small.assets.get({ asset: original('a1'), request: GET })).rejects.toMatchObject({ code: 'asset-unavailable' });
    expect(storageBudgets(BUDGETS)).toEqual(BUDGETS);
    expect(storageBudgets(JSON.stringify(BUDGETS))).toEqual(BUDGETS);
    expect(storageBudgets({ ...BUDGETS, maxDocuments: undefined })).toBeNull();
    expect(storageBudgets({ ...BUDGETS, extra: 1 })).toBeNull();
    expect(storageBudgets({ ...BUDGETS, maxRowsPerBatch: 0 })).toBeNull();
    expect(storageBudgets(undefined)).toBeNull();
  });
});

describe('results versions (D1 read model, R2 package files)', () => {
  it('stores an imported candidate without publishing it, and refuses its derivatives', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'candidate'), rv = pkg.identity.resultsVersion;
    expect(await stage(w, pkg)).toEqual({ kind: 'stored', resultsVersion: rv, repeated: false });
    expect(await stage(w, pkg, { operationId: 'import-again' })).toEqual({ kind: 'stored', resultsVersion: rv, repeated: true });
    expect(await w.store.activeVersionId({ caseId: ids.caseA })).toBeNull();
    expect(await w.store.getCase({ caseId: ids.caseA })).toMatchObject({ publication: { kind: 'none' } });
    await expect(w.store.packageFile({ caseId: ids.caseA, resultsVersion: rv, path: 'manifest.json' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.store.documentRows({ caseId: ids.caseA, resultsVersion: rv })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await w.store.getVersion({ resultsVersion: rv }).catch((e) => e.code)).toBe('forbidden');
  });

  it('reads a published version’s canonical projection, package files and verification', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'published'), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    await stage(w, pkg);
    publish(w.db, 'case-a', rv);
    expect(await w.store.activeVersionId({ caseId: ids.caseA })).toBe(rv);
    expect(await w.store.listCases()).toMatchObject([{ caseId: 'case-a', publication: { kind: 'published', resultsVersion: rv } }]);
    const rows = await w.store.documentRows(scope);
    expect(rows.rows.map((r) => [r.ref, r.ord, r.source])).toEqual([['OD-001', 0, 'results'], ['OD-002', 1, 'results']]);
    const listed = JSON.parse(pkg.projection.chronologyJson);
    expect(rows.rows.map((r) => r.list)).toEqual(listed);
    expect(rows.rows[0]!.state).toEqual(JSON.parse(pkg.projection.documents.find((d) => d.ref === 'OD-001')!.state_json));
    expect(await w.store.packageFilePaths(scope)).toEqual([...pkg.files.keys()].sort());
    expect(await w.store.packageFile({ ...scope, path: 'manifest.json' })).toEqual(pkg.files.get('manifest.json'));
    expect(await w.store.datasetOf({ ...scope, key: 'chronology' })).toHaveLength(2);
    expect(await w.store.datasetKeys(scope)).toEqual(['chronology']);
    expect(await w.store.verifyVersion(scope)).toMatchObject({ ok: true });
    expect(await w.store.getVersion({ resultsVersion: rv })).toMatchObject({ id: rv, case_id: 'case-a', manifest_sha256: pkg.identity.manifestSha256, verdict: pkg.validation.verdict });
    expect(await w.store.documentCounts(scope)).toEqual({ total: 2, imported: 2, provided: 0, failed: [] });
    expect((await w.store.fingerprints(scope)).map((f) => f.sha256)).toEqual(pkg.docs.map((d) => shaOf(d.bytes)));
    expect(await w.store.stateRevision({ caseId: ids.caseA })).toBe('rev-1');
  });

  it('refuses a package file changed at rest, and verification reports it', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'rot'), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    await stage(w, pkg);
    publish(w.db, 'case-a', rv);
    const key = [...w.bucket.objects.keys()].find((k) => k.startsWith('pkg/') && w.bucket.objects.get(k)!.sha256 === shaOf(pkg.files.get('datasets/chronology.json')!))!;
    w.bucket.tamper(key, (b) => { b[10]! ^= 1; return b; });
    await expect(w.store.datasetOf({ ...scope, key: 'chronology' })).rejects.toMatchObject({ code: 'integrity' });
    expect(await w.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
  });

  it('refuses every derivative of a withdrawn version, Keep-marked included, while originals stay readable', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'withdrawn'), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    await stage(w, pkg);
    await upload(w, 'a1', pdf('kept original'));
    w.db.exec('UPDATE rs_results_version SET keep = 1 WHERE version_id = ?', rv);
    publish(w.db, 'case-a', rv);
    w.db.exec("INSERT INTO rs_preview (version_id, asset_id, sha256, size, media_type, filename, object_key) VALUES (?, 'p1', ?, 1, 'application/pdf', 'p1.pdf', 'preview/x')", rv, 'b'.repeat(64));
    withdraw(w.db, 'case-a', rv);
    expect(await w.store.getCase({ caseId: ids.caseA })).toMatchObject({ publication: { kind: 'withdrawn' } });
    expect(await w.store.activeVersionId({ caseId: ids.caseA })).toBeNull();
    for (const read of [() => w.store.packageFile({ ...scope, path: 'manifest.json' }), () => w.store.documentRows(scope), () => w.store.verifyVersion(scope), () => w.store.seeds(scope), () => w.store.listJson(scope)])
      await expect(read()).rejects.toMatchObject({ code: 'forbidden' });
    // Withdrawal binds even if a stale pointer still names the version.
    w.db.exec("UPDATE rs_publication SET state = 'published' WHERE case_id = 'case-a'");
    await expect(w.store.documentRows(scope)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.assets.get({ asset: { kind: 'preview', caseId: ids.caseA, resultsVersion: rv, assetId: 'p1' }, request: GET })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.assets.get({ asset: original('a1'), request: GET })).status).toBe(200);
  });

  it('a failed import leaves nothing readable, and a retry stores the version whole', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'failed'), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    const files = new Map(pkg.files);
    const chronology = new Uint8Array(files.get('datasets/chronology.json')!);
    chronology[20]! ^= 1;
    files.set('datasets/chronology.json', chronology);
    expect(await stage(w, pkg, { files })).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
    expect([...w.bucket.objects.keys()].filter((k) => k.startsWith('pkg/'))).toEqual([]);
    // A D1 failure in the middle of the rows: the version stays staging and is never served, even if published.
    w.db.failNext = /INSERT INTO rs_document/;
    await expect(stage(w, pkg)).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.db.rows<{ state: string }>('SELECT state FROM rs_results_version')).toEqual([{ state: 'staging' }]);
    w.db.exec("INSERT INTO rs_publication (case_id, state, version_id) VALUES ('case-a', 'published', ?)", rv);
    await expect(w.store.documentRows(scope)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await stage(w, pkg, { operationId: 'import-retry' })).toEqual({ kind: 'stored', resultsVersion: rv, repeated: false });
    expect((await w.store.documentRows(scope)).rows).toHaveLength(2);
    expect(w.db.rows<{ attempt: number }>('SELECT attempt FROM rs_results_version')).toEqual([{ attempt: 2 }]);
  });

  it('refuses a package of another case, a projection that disagrees with it, and a package over budget', async () => {
    const w = world(), other = await syntheticPackage('case-b', 'other-case'), pkg = await syntheticPackage('case-a', 'checks');
    expect(await stage(w, other)).toMatchObject({ kind: 'refused', reason: 'wrong-case' });
    const short = { ...pkg.projection, documents: pkg.projection.documents.slice(1) };
    expect(await stage(w, pkg, { projection: short })).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(await stage(w, pkg, { identity: { ...pkg.identity, resultsVersion: resultsVersion(`sha256:${'c'.repeat(64)}`) } })).toMatchObject({ kind: 'refused', reason: 'integrity' });
    const tight = world({ budgets: { ...BUDGETS, maxPackageFiles: 2 } });
    expect(await stage(tight, pkg)).toMatchObject({ kind: 'refused', reason: 'over-budget' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });
});
