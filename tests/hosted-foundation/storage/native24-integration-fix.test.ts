// NATIVE24 original-facts integration fix (review findings M1 and M2 of the GRS-115 supplemental). UNIT evidence only: D1 and R2
// are the doubles in ./doubles.ts. Originals are uploaded through the REAL client intake controller (GRS-137) over the real
// submissions repository and GRS-115 intake (fixture.ts `submit`), so the asset ids are `sub-<operationId>`, the association
// filename is the basename, and the case-relative path lives only in the finalized submission. The canonical answer is still
// the local `project()` of a real temporary case folder.
import { describe, expect, it } from 'vitest';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { id, type CaseRevision } from '../../../src/lib/server/runtime/ids.ts';
import { BUDGETS, QUOTAS, VERIFY_BUDGETS, deployment, grantedIdentity, ids, originalsPackage, packageOver, pdf, publish, shaOf, submissionOp, submit } from './fixture.ts';

type Pkg = Awaited<ReturnType<typeof originalsPackage>>;
type Row = { status: string; real_path: string | null; sha256: string | null; size: number | null; download_only: number };
type Budgets = typeof BUDGETS & typeof VERIFY_BUDGETS;
const at = (ms: number) => () => new Date(ms);
const T0 = Date.parse('2001-01-01T00:00:00Z');

function world(o: { dep?: ReturnType<typeof deployment>; budgets?: Budgets; clock?: () => Date } = {}) {
  const dep = o.dep ?? deployment('client-a', ['case-a', 'case-b']);
  const budgets = o.budgets ?? { ...BUDGETS, ...VERIFY_BUDGETS };
  const bindings = { db: dep.db, bucket: dep.bucket };
  // A read-only grantee: a client user with case read grants and nothing else.
  const who = grantedIdentity(ids.clientA, ['case-a', 'case-b']);
  const results = createCloudResults({ bindings, clientId: ids.clientA, budgets, identity: who.identity, record: async () => {}, stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision, now: o.clock ?? at(T0) });
  const staging = createResultsStaging({ bindings, clientId: ids.clientA, budgets, quotas: QUOTAS, authorize: async () => {}, now: at(T0) });
  return { ...dep, ...results, staging, who };
}
type World = ReturnType<typeof world>;
const stage = (w: World, pkg: { files: Pkg['files']; identity: Pkg['identity']; validation: Pkg['validation']; projection: Pkg['projection'] }, over: Record<string, unknown> = {}) =>
  w.staging.stage({ caseId: ids.caseA, operationId: 'import-1', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection, ...over } as never);
const stored = (w: World) => w.db.rows<{ asset_key: string; row_json: string }>('SELECT asset_key, row_json FROM rs_asset ORDER BY asset_key').map((r) => ({ key: r.asset_key, ...(JSON.parse(r.row_json) as Row) }));
const none = (w: World) => { expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]); expect([...w.bucket.objects.keys()].filter((k) => k.startsWith('pkg/'))).toEqual([]); };
const withoutDiagnostics = (overview: string) => ({ ...JSON.parse(overview), diagnostics: null });
function expectCanonical(w: World, pkg: { projection: Pkg['projection'] }) {
  const asset = Object.fromEntries(stored(w).map((r) => [r.key, r]));
  for (const c of pkg.projection.assets) expect(asset[c.key], c.key).toMatchObject({ status: c.status, real_path: c.real_path, sha256: c.sha256, size: c.size, download_only: c.download_only });
  expect(w.db.rows<{ ref: string; state_json: string }>('SELECT ref, state_json FROM rs_document ORDER BY ref').map((r) => [r.ref, JSON.parse(r.state_json)]))
    .toEqual([...pkg.projection.documents].sort((a, b) => (a.ref < b.ref ? -1 : 1)).map((d) => [d.ref, JSON.parse(d.state_json)]));
  expect(withoutDiagnostics(w.db.rows<{ overview: string }>('SELECT overview FROM rs_results_version')[0]!.overview)).toEqual(withoutDiagnostics(pkg.projection.overview));
}
const asSubmitted = (pkg: Pkg) => pkg.docs.filter((d) => d.disk !== 'missing').map((d) => ({ ref: d.ref, path: d.onDisk, bytes: d.bytes }));
const subAsset = (caseId: string, ref: string) => `sub-${submissionOp(caseId, ref)}`;
const link = (o: { refs: string[]; packagePath: string; storedPath: string; ref: string; bytes: Uint8Array; pathMatch?: 'literal' }) =>
  ({ packageRefs: o.refs, packagePath: o.packagePath, storedPath: o.storedPath, submissionAssetId: subAsset('case-a', o.ref), sha256: shaOf(o.bytes), size: o.bytes.byteLength, pathMatch: o.pathMatch ?? 'literal' });

describe('M1: canonical facts match the case’s own finalized intake originals by path and fingerprint', () => {
  it('an original uploaded through the real client intake (sub-<op>, basename, path in the finalized submission) is verified, and a folded name is a case mismatch', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'n24-intake', ['ok', 'missing', 'case']);
    await submit(w, 'case-a', asSubmitted(pkg));
    // The intake's own identity, unchanged: no package key, no full path in the association.
    expect(w.db.rows('SELECT asset_id, filename FROM rs_case_original ORDER BY asset_id')).toEqual([
      { asset_id: subAsset('case-a', 'OD-001'), filename: 'OD-001 letter 1.pdf' }, { asset_id: subAsset('case-a', 'OD-003'), filename: 'OD-003 LETTER 3.pdf' }]);
    expect(w.db.rows("SELECT path FROM submissions_file ORDER BY path")).toEqual([{ path: pkg.docs[0]!.onDisk }, { path: pkg.docs[2]!.onDisk }]);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored', repeated: false });
    expectCanonical(w, pkg);
    expect(stored(w).map((r) => [r.key, r.status])).toEqual([['OD-001', 'verified'], ['OD-002', 'unavailable'], ['OD-003', 'case-mismatch']]);
    publish(w.db, 'case-a', pkg.identity.resultsVersion);
    expect(await w.store.verifyVersion({ caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion })).toMatchObject({ ok: true });
  });

  it('package keys are local aliases: two keys indexing one path are each verified by the one upload, with no alias rows', async () => {
    const w = world(), bytes = pdf('n24-alias'), shared = 'DISCOVERY/shared letter.pdf';
    const pkg = await packageOver('case-a', 'n24-alias', [{ ref: 'OD-001', disk: 'ok' as const, path: shared, onDisk: shared, bytes }, { ref: 'OD-002', disk: 'ok' as const, path: shared, onDisk: shared, bytes }]);
    expect(pkg.projection.assets.map((a) => a.status)).toEqual(['verified', 'verified']);
    await submit(w, 'case-a', [{ ref: 'upload-1', path: shared, bytes }]);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expectCanonical(w, pkg);
    expect(w.db.rows('SELECT asset_id FROM rs_case_original')).toEqual([{ asset_id: subAsset('case-a', 'upload-1') }]);
  });

  it('a reserved submission (bound by GRS-115, not finalized by the intake) is no fact', async () => {
    const w = world(), claimed = await originalsPackage('case-a', 'n24-reserved', ['ok']), honestMissing = await originalsPackage('case-a', 'n24-reserved', ['missing']);
    const [r] = await submit(w, 'case-a', asSubmitted(claimed), { commit: false });
    expect(r!.status).toBe(503);
    expect(w.db.rows('SELECT state FROM submissions_upload')).toEqual([{ state: 'reserved' }]);
    expect(w.db.rows('SELECT asset_id FROM rs_case_original')).toHaveLength(1);
    expect(await stage(w, claimed)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    none(w);
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((x) => x.status)).toEqual(['unavailable']);
  });

  it('another case’s finalized submission at the same path is no fact of this case', async () => {
    const w = world(), claimed = await originalsPackage('case-a', 'n24-other', ['ok']), honestMissing = await originalsPackage('case-a', 'n24-other', ['missing']);
    await submit(w, 'case-b', asSubmitted(claimed));
    expect(await stage(w, claimed)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
  });

  it('conflicting finalized revisions at one path: no arbitrary pick; only an exact import link selects one', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'n24-conflict', ['ok']), d = pkg.docs[0]!, later = pdf('n24-conflict-later');
    await submit(w, 'case-a', [{ ref: 'r1', path: d.path, bytes: d.bytes }, { ref: 'r2', path: d.path, bytes: later }]);
    const refused = await stage(w, pkg);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'original-link-required' });
    expect((refused as { detail: readonly string[] }).detail.join('\n')).toMatch(new RegExp(`OD-001.*${subAsset('case-a', 'r1')}.*${subAsset('case-a', 'r2')}`));
    none(w);
    // A link naming the other revision names bytes that are not the indexed ones: a genuine mismatch, never relabelled.
    expect(await stage(w, pkg, { originalLinks: [link({ refs: ['OD-001'], packagePath: d.path, storedPath: d.path, ref: 'r2', bytes: later })] })).toMatchObject({ kind: 'refused', reason: 'integrity' });
    // A link that names one revision with another revision's fingerprint matches nothing.
    expect(await stage(w, pkg, { originalLinks: [{ ...link({ refs: ['OD-001'], packagePath: d.path, storedPath: d.path, ref: 'r2', bytes: d.bytes }) }] })).toMatchObject({ kind: 'refused', reason: 'integrity' });
    none(w);
    expect(await stage(w, pkg, { originalLinks: [link({ refs: ['OD-001'], packagePath: d.path, storedPath: d.path, ref: 'r1', bytes: d.bytes })] })).toMatchObject({ kind: 'stored' });
    expectCanonical(w, pkg);
  });

  it('an import link cannot make an original present: not for a reserved upload, a wrong path match, an unknown key or a malformed link', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'n24-badlink', ['ok', 'missing']), d = pkg.docs[0]!, gone = pkg.docs[1]!;
    await submit(w, 'case-a', [{ ref: 'r1', path: d.path, bytes: d.bytes }]);
    await submit(w, 'case-a', [{ ref: 'r2', path: gone.path, bytes: gone.bytes }], { commit: false });
    const good = link({ refs: ['OD-001'], packagePath: d.path, storedPath: d.path, ref: 'r1', bytes: d.bytes });
    for (const bad of [
      [good, link({ refs: ['OD-002'], packagePath: gone.path, storedPath: gone.path, ref: 'r2', bytes: gone.bytes })],
      [{ ...good, pathMatch: 'case-nfc-unique', preservedWarning: { code: 'ORIG_CASE_MISMATCH', fingerprints: ['x'] } }],
      [{ ...good, packageRefs: ['OD-404'] }],
      [{ ...good, packagePath: 'DISCOVERY/elsewhere.pdf' }],
      [{ ...good, sha256: 'not-a-digest' }],
      [good, good],
    ]) {
      const r = await stage(w, pkg, { originalLinks: bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    }
    none(w);
    expect(await stage(w, pkg, { originalLinks: [good] })).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((x) => x.status)).toEqual(['verified', 'unavailable']);
  });

  it('a later conflicting revision at the same path does not unverify a published version', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'n24-latest', ['ok']), d = pkg.docs[0]!;
    await submit(w, 'case-a', [{ ref: 'r1', path: d.path, bytes: d.bytes }]);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    publish(w.db, 'case-a', pkg.identity.resultsVersion);
    await submit(w, 'case-a', [{ ref: 'r2', path: d.path, bytes: pdf('n24-latest-corrected') }]);
    expect(await w.store.verifyVersion({ caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion })).toMatchObject({ ok: true });
  });
});

async function publishedViaIntake(tag: string, alias = false) {
  const w = world(), bytes = pdf(`${tag}-shared`), shared = 'DISCOVERY/shared letter.pdf';
  const pkg = alias
    ? await packageOver('case-a', tag, [{ ref: 'OD-001', disk: 'ok' as const, path: shared, onDisk: shared, bytes }, { ref: 'OD-002', disk: 'ok' as const, path: shared, onDisk: shared, bytes }])
    : await originalsPackage('case-a', tag, ['ok', 'ok']);
  await submit(w, 'case-a', alias ? [{ ref: 'upload-1', path: shared, bytes }] : asSubmitted(pkg));
  expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
  publish(w.db, 'case-a', pkg.identity.resultsVersion);
  const files = w.db.rows<{ n: number; b: number }>('SELECT COUNT(*) AS n, SUM(size) AS b FROM rs_package_file')[0]!;
  const originals = alias ? [bytes] : pkg.docs.map((d) => d.bytes);
  const plan = { objects: files.n + originals.length, bytes: files.b + originals.reduce((n, b) => n + b.byteLength, 0) };
  return { w, pkg, plan, scope: { caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion } };
}

describe('M2: verification by a read-only grantee is bounded before any read', () => {
  it('a version over the per-call object or byte bound is refused before any R2 read and reserves nothing', async () => {
    const { w, plan, scope } = await publishedViaIntake('n24-call');
    for (const tight of [{ maxVerifyObjects: plan.objects - 1 }, { maxVerifyBytes: plan.bytes - 1 }]) {
      const r = world({ dep: w, budgets: { ...BUDGETS, ...VERIFY_BUDGETS, ...tight } });
      await r.store.getVersion({ resultsVersion: scope.resultsVersion }); // the storage gate's own read happens once per reader
      const gets = w.bucket.gets;
      expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'over-budget' });
      expect(w.bucket.gets).toBe(gets);
      expect(w.db.rows('SELECT * FROM rs_verification_work')).toEqual([]);
    }
    expect(await world({ dep: w }).store.verifyVersion(scope)).toMatchObject({ ok: true });
  });

  it('repeat calls draw on one atomic per-case work window in D1; an exhausted window answers busy with no R2 read, and published reads stay usable', async () => {
    const { w, plan, scope } = await publishedViaIntake('n24-window');
    let clock = T0;
    const r = world({ dep: w, clock: () => new Date(clock), budgets: { ...BUDGETS, ...VERIFY_BUDGETS, maxVerifyObjectsPerCaseWindow: plan.objects * 2, maxVerifyBytesPerCaseWindow: plan.bytes * 2 } });
    await r.store.getVersion({ resultsVersion: scope.resultsVersion });
    let gets = w.bucket.gets;
    for (let i = 0; i < 2; i++) {
      expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: true });
      // No cross-request cache: every call reads each package file and each distinct original again, once.
      expect(w.bucket.gets - gets).toBe(plan.objects);
      gets = w.bucket.gets;
    }
    const busy = await Promise.all([r.store.verifyVersion(scope), world({ dep: w, clock: () => new Date(clock), budgets: { ...BUDGETS, ...VERIFY_BUDGETS, maxVerifyObjectsPerCaseWindow: plan.objects * 2, maxVerifyBytesPerCaseWindow: plan.bytes * 2 } }).store.verifyVersion(scope)]);
    for (const b of busy) expect(b).toMatchObject({ ok: false, reason: 'busy' });
    expect(w.bucket.gets - gets).toBe(1); // only the second reader's storage gate; no package file or original
    expect(w.db.rows('SELECT objects, bytes FROM rs_verification_work')).toEqual([{ objects: plan.objects * 2, bytes: plan.bytes * 2 }]);
    // Normal published reads do not depend on the verification window.
    expect((await r.store.documentRows(scope)).rows).toHaveLength(2);
    expect(await r.store.getVersion({ resultsVersion: scope.resultsVersion })).toBeTruthy();
    clock += VERIFY_BUDGETS.verifyWindowSeconds * 1000;
    expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: true });
    expect(w.db.rows<{ objects: number }>('SELECT objects FROM rs_verification_work')).toEqual([{ objects: plan.objects }]);
  });

  it('aliased keys share one original read per call, and a changed original is never reported verified to save work', async () => {
    const { w, pkg, plan, scope } = await publishedViaIntake('n24-alias-cost', true);
    let clock = T0;
    const r = world({ dep: w, clock: () => new Date(clock), budgets: { ...BUDGETS, ...VERIFY_BUDGETS, maxVerifyObjectsPerCaseWindow: plan.objects, maxVerifyBytesPerCaseWindow: plan.bytes } });
    await r.store.getVersion({ resultsVersion: scope.resultsVersion });
    const gets = w.bucket.gets;
    expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: true });
    expect(w.bucket.gets - gets).toBe(plan.objects);
    w.bucket.tamper(`orig/${shaOf(pkg.docs[0]!.bytes)}`, (b) => { b[b.length - 2]! ^= 1; return b; });
    expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'busy' });
    clock += VERIFY_BUDGETS.verifyWindowSeconds * 1000;
    expect(await r.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
  });
});
