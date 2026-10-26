// Real hosted reader SQL/projector and real intake, over the existing SQLite-D1 / memory-R2 doubles. Not workerd evidence.
import { describe, expect, it } from 'vitest';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { originalAttributions, publishedReadiness } from '../../../src/lib/results/hosted/published-reads.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { chronologyOf } from '../../../src/lib/views/hosted/case.server.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { BUDGETS, QUOTAS, deployment, grantedIdentity, ids, originalsPackage, packageOver, pdf, provide, publish, submit, submissionOp, withdraw } from '../../hosted-foundation/storage/fixture.ts';
import { fake } from './doubles.ts';

const now = () => new Date('2001-01-01T00:00:00Z');
const options = () => {
  const dep = deployment('client-a', ['case-a', 'case-b']);
  const who = grantedIdentity(ids.clientA, ['case-a']);
  const events: unknown[] = [];
  const o = { bindings: dep, clientId: ids.clientA, budgets: BUDGETS, identity: who.identity, record: async (e: unknown) => { events.push(e); }, stateRevision: async () => id('case-revision', 'r1'), now };
  return { ...dep, ...who, events, o, reader: (budgets = BUDGETS) => createCloudResults({ ...o, budgets }), staging: createResultsStaging({ ...o, quotas: QUOTAS, authorize: async () => {} }) };
};
type World = ReturnType<typeof options>;
type Pkg = Awaited<ReturnType<typeof originalsPackage>>;
const scope = (pkg: Pkg) => ({ caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion });
async function store(w: World, pkg: Pkg) {
  const result = await w.staging.stage({ caseId: ids.caseA, operationId: 'import-ui', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection });
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'stored' });
  publish(w.db, 'case-a', pkg.identity.resultsVersion);
}
async function setup(disks: Parameters<typeof originalsPackage>[2] = ['ok', 'ok']) {
  const w = options(), pkg = await originalsPackage('case-a', 'ui-mapping', disks);
  await submit(w, 'case-a', pkg.docs.filter((d) => d.disk !== 'missing').map((d) => ({ ...d, path: d.onDisk })));
  await store(w, pkg);
  return { w, pkg };
}
const asset = (ref: string) => `sub-${submissionOp('case-a', ref)}`;

it('M2: intake sub-* assets resolve by the immutable path and fingerprint, all the way to chronology links', async () => {
  const { w, pkg } = await setup();
  const ports = w.reader();
  expect(await originalAttributions(ports.store, scope(pkg))).toEqual([{ ref: 'OD-001', assetId: asset('OD-001') }, { ref: 'OD-002', assetId: asset('OD-002') }]);
  const services = { ...fake({ publication: { kind: 'none' } }).services, ...ports, identity: w.identity };
  const data = await chronologyOf(services, ids.caseA, pkg.identity.resultsVersion, new URLSearchParams());
  expect(data.items.map((r) => [r.originalAssetId, r.originalHref])).toEqual(['OD-001', 'OD-002'].map((ref) => [asset(ref), `/cases/case-a/originals/${asset(ref)}`]));
});

it('M2: several package aliases can cite one finalized original without creating ref-shaped association rows', async () => {
  const w = options(), bytes = pdf('one-original');
  const pkg = await packageOver('case-a', 'ui-aliases', ['OD-001', 'OD-002'].map((ref) => ({ ref, disk: 'ok' as const, path: 'DISCOVERY/shared.pdf', onDisk: 'DISCOVERY/shared.pdf', bytes })));
  await submit(w, 'case-a', [{ ref: 'one-input', path: 'DISCOVERY/shared.pdf', bytes }]);
  await store(w, pkg);
  expect(await originalAttributions(w.reader().store, scope(pkg))).toEqual(['OD-001', 'OD-002'].map((ref) => ({ ref, assetId: asset('one-input') })));
  expect(w.db.rows<{ asset_id: string }>('SELECT asset_id FROM rs_case_original')).toEqual([{ asset_id: asset('one-input') }]);
});

it('M2: an unrelated ref-shaped original cannot link a missing/unmapped citation', async () => {
  const w = options(), pkg = await originalsPackage('case-a', 'ui-unmapped', ['missing', 'ok']);
  await submit(w, 'case-a', [{ ...pkg.docs[1]!, path: pkg.docs[1]!.onDisk }]);
  await provide(w, 'case-a', [{ ref: 'OD-001', filename: 'OTHER/unrelated.pdf', mediaType: 'application/pdf', bytes: pdf('unrelated') }]);
  await store(w, pkg);
  expect(await originalAttributions(w.reader().store, scope(pkg))).toEqual([{ ref: 'OD-002', assetId: asset('OD-002') }]);
});

it('M2: the recorded real path handles folded names, and new bytes at the path never redirect an old citation', async () => {
  const { w, pkg } = await setup(['case', 'case']);
  expect(await originalAttributions(w.reader().store, scope(pkg))).toHaveLength(2);
  const d = pkg.docs[0]!;
  await submit(w, 'case-a', [{ ref: 'new-revision', path: d.onDisk, bytes: pdf('new-revision') }]);
  expect((await originalAttributions(w.reader().store, scope(pkg)))[0]).toEqual({ ref: d.ref, assetId: asset(d.ref) });
  w.db.exec('DELETE FROM rs_case_original WHERE case_id = ? AND asset_id = ?', 'case-a', asset(d.ref));
  expect(await originalAttributions(w.reader().store, scope(pkg))).toEqual([{ ref: 'OD-002', assetId: asset('OD-002') }]);
});

it('M2: the recorded real path also resolves NFC/NFD originals from the direct intake contract', async () => {
  const w = options(), pkg = await originalsPackage('case-a', 'ui-normalized', ['nfd', 'ok']);
  await provide(w, 'case-a', pkg.uploads);
  await store(w, pkg);
  expect(await originalAttributions(w.reader().store, scope(pkg))).toEqual(['OD-001', 'OD-002'].map((ref) => ({ ref, assetId: ref })));
});

it('M2: bare association rows without a finalized intake submission never become a mapping', async () => {
  const w = options(), pkg = await originalsPackage('case-a', 'ui-unfinalized', ['missing', 'ok']);
  await submit(w, 'case-a', [pkg.docs[0]!], { commit: false });
  await submit(w, 'case-a', [pkg.docs[1]!]);
  expect(w.db.rows('SELECT * FROM rs_case_original WHERE asset_id = ?', asset('OD-001'))).toHaveLength(1);
  await store(w, pkg);
  expect(await originalAttributions(w.reader().store, scope(pkg))).toEqual([{ ref: 'OD-002', assetId: asset('OD-002') }]);
});

describe('cheap published readiness', () => {
  it.each(['busy', 'over-budget'] as const)('M3: deep %s does not block reads, consume the work window or read package/original bytes', async (reason) => {
    const { w, pkg } = await setup();
    const budgets = { ...BUDGETS, ...(reason === 'busy' ? { maxVerifyObjectsPerCaseWindow: 1 } : { maxVerifyObjects: 1 }) };
    const { store: reader } = w.reader(budgets);
    expect(await reader.verifyVersion(scope(pkg))).toMatchObject({ ok: false, reason });
    const before = w.db.rows('SELECT * FROM rs_verification_work'), gets = w.bucket.gets;
    for (let i = 0; i < 12; i++) {
      await publishedReadiness(reader, scope(pkg));
      await reader.documentCounts(scope(pkg));
      await originalAttributions(reader, scope(pkg));
    }
    expect(w.bucket.gets).toBe(gets);
    expect(w.db.rows('SELECT * FROM rs_verification_work')).toEqual(before);
  });

  it.each(['row', 'count', 'asset', 'list', 'overview'] as const)('M3: genuine %s corruption is refused, never made ready', async (kind) => {
    const { w, pkg } = await setup();
    const changes = {
      row: "UPDATE rs_document SET row_json = '{}' WHERE ref = 'OD-001'",
      count: 'UPDATE rs_results_version SET expected_documents = expected_documents + 1',
      asset: "UPDATE rs_asset SET row_json = '{}' WHERE asset_key = 'OD-001'",
      list: "UPDATE rs_document SET list_json = '{}' WHERE ref = 'OD-001'",
      overview: "UPDATE rs_results_version SET overview = '{}'",
    };
    w.db.exec(changes[kind]);
    await expect(publishedReadiness(w.reader().store, scope(pkg))).rejects.toMatchObject({ code: 'integrity' });
  });

  it('cheap readiness never replaces deep or serve-time original hashing; same-size byte corruption still refuses delivery', async () => {
    const { w, pkg } = await setup();
    const ports = w.reader();
    await publishedReadiness(ports.store, scope(pkg));
    const row = w.db.rows<{ object_key: string }>('SELECT object_key FROM rs_original ORDER BY sha256')[0]!;
    w.bucket.tamper(row.object_key, (bytes) => { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; return bytes; });
    expect(await ports.store.verifyVersion(scope(pkg))).toMatchObject({ ok: false, reason: 'integrity' });
    const original = w.db.rows<{ asset_id: string }>('SELECT c.asset_id FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256 WHERE o.object_key = ?', row.object_key)[0]!;
    await expect(ports.assets.get({ asset: { kind: 'original', caseId: ids.caseA, assetId: original.asset_id }, request: { method: 'GET', range: 'bytes=0-3', ifRange: null } })).rejects.toMatchObject({ code: 'changed-original' });
  });

  it('M3: D1 availability is retryable, and a failed verified load is evicted so the same reader can recover', async () => {
    const { w, pkg } = await setup();
    const { store: reader } = w.reader();
    w.db.failNext = /SELECT ref, ord/;
    await expect(publishedReadiness(reader, scope(pkg))).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(publishedReadiness(reader, scope(pkg))).resolves.toBeUndefined();
  });

  it('M3: publication withdrawal, wrong case, wrong client and revoked authority all fail closed', async () => {
    const { w, pkg } = await setup();
    const { store: reader } = w.reader();
    await publishedReadiness(reader, scope(pkg));
    await expect(publishedReadiness(reader, { ...scope(pkg), caseId: ids.caseB })).rejects.toMatchObject({ code: 'forbidden' });
    const other = createCloudResults({ ...w.o, clientId: ids.clientB }).store;
    await expect(publishedReadiness(other, scope(pkg))).rejects.toMatchObject({ code: 'storage-unavailable' });
    w.grants.clear();
    await expect(originalAttributions(reader, scope(pkg))).rejects.toMatchObject({ code: 'forbidden' });
    w.grants.add('case-a');
    withdraw(w.db, 'case-a', pkg.identity.resultsVersion);
    await expect(publishedReadiness(reader, scope(pkg))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(originalAttributions(reader, scope(pkg))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechecks authority and publication after awaited work, and enforces read-original for attribution', async () => {
    const { w, pkg } = await setup();
    const original = w.identity.authorize;
    let reads = 0;
    w.identity.authorize = async (q) => {
      await original(q);
      if (q.operation === 'read' && ++reads === 2) withdraw(w.db, 'case-a', pkg.identity.resultsVersion);
    };
    await expect(publishedReadiness(w.reader().store, scope(pkg))).rejects.toMatchObject({ code: 'forbidden' });
    const next = await setup();
    const auth = next.w.identity.authorize;
    next.w.identity.authorize = async (q) => { if (q.operation === 'read-original') throw contractError('forbidden'); await auth(q); };
    await expect(originalAttributions(next.w.reader().store, scope(next.pkg))).rejects.toMatchObject({ code: 'forbidden' });
    expect(next.w.events).toContainEqual(expect.objectContaining({ action: 'asset.list', outcome: 'denied' }));
  });
});
