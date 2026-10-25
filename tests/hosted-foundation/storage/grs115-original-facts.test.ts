// GRS-115 approved supplemental correction: original status derives from verified per-case D1/R2 facts (canonical local
// semantics), never from a claimed projection or an operator flag. UNIT evidence only: D1 and R2 are the doubles in
// ./doubles.ts, not Cloudflare. Every expectation of the canonical answer is the local `project()` of a real temporary case
// folder (fixture.ts `originalsPackage`), so parity is compared with the shipped local projector, not with a restatement.
import { describe, expect, it } from 'vitest';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { readModelDigest } from '../../../src/lib/local-case/project.server.ts';
import { id, type CaseRevision } from '../../../src/lib/server/runtime/ids.ts';
import { BUDGETS, QUOTAS, deployment, grantedIdentity, ids, pdf, provide, provideOriginals, publish, shaOf, syntheticPackage, originalsPackage, type Disk } from './fixture.ts';

const now = () => new Date('2001-01-01T00:00:00Z');
type Pkg = Awaited<ReturnType<typeof originalsPackage>>;
type Row = { status: string; real_path: string | null; sha256: string | null; size: number | null; download_only: number };

function world(dep = deployment('client-a', ['case-a', 'case-b'])) {
  const bindings = { db: dep.db, bucket: dep.bucket };
  const who = grantedIdentity(ids.clientA, ['case-a', 'case-b']);
  const results = createCloudResults({ bindings, clientId: ids.clientA, budgets: BUDGETS, identity: who.identity, record: async () => {}, stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision });
  const staging = createResultsStaging({ bindings, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now });
  return { ...dep, ...results, staging };
}
type World = ReturnType<typeof world>;
const stage = (w: World, pkg: Pkg | Awaited<ReturnType<typeof syntheticPackage>>, over: Record<string, unknown> = {}) =>
  w.staging.stage({ caseId: ids.caseA, operationId: 'import-1', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection, ...over });
const stored = (w: World) => w.db.rows<{ asset_key: string; row_json: string }>('SELECT asset_key, row_json FROM rs_asset ORDER BY asset_key').map((r) => ({ key: r.asset_key, ...(JSON.parse(r.row_json) as Row) }));
const none = (w: World) => { expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]); expect([...w.bucket.objects.keys()].filter((k) => k.startsWith('pkg/'))).toEqual([]); };
const withoutDiagnostics = (overview: string) => ({ ...JSON.parse(overview), diagnostics: null });
/** The canonical local read model, which the hosted store must equal once it stands on the same facts. */
function expectCanonical(w: World, pkg: Pkg) {
  const asset = Object.fromEntries(stored(w).map((r) => [r.key, r]));
  for (const c of pkg.projection.assets) expect(asset[c.key], c.key).toMatchObject({ status: c.status, real_path: c.real_path, sha256: c.sha256, size: c.size, download_only: c.download_only });
  expect(w.db.rows<{ ref: string; state_json: string }>('SELECT ref, state_json FROM rs_document ORDER BY ref').map((r) => [r.ref, JSON.parse(r.state_json)]))
    .toEqual([...pkg.projection.documents].sort((a, b) => (a.ref < b.ref ? -1 : 1)).map((d) => [d.ref, JSON.parse(d.state_json)]));
  expect(withoutDiagnostics(w.db.rows<{ overview: string }>('SELECT overview FROM rs_results_version')[0]!.overview)).toEqual(withoutDiagnostics(pkg.projection.overview));
}
async function honest(disks: readonly Disk[], tag: string, caseId = 'case-a') {
  const w = world(), pkg = await originalsPackage(caseId, tag, disks);
  await provide(w, caseId, pkg.uploads);
  return { w, pkg };
}

describe('canonical original status from verified per-case facts (the local projection is the oracle)', () => {
  it('honest missing: an original nobody uploaded is unavailable, as the case folder says, and the import is accepted', async () => {
    const { w, pkg } = await honest(['ok', 'missing'], 'f-missing');
    expect(pkg.projection.assets.find((a) => a.key === 'OD-002')!.status).toBe('unavailable');
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored', repeated: false });
    expectCanonical(w, pkg);
    expect(JSON.parse(w.db.rows<{ overview: string }>('SELECT overview FROM rs_results_version')[0]!.overview).originals).toMatchObject({ verified: 1, missing: 1 });
  });

  it('unique case or normalisation mismatch: found only by a folded name, recorded with its real name, accepted', async () => {
    const { w, pkg } = await honest(['ok', 'case', 'nfd'], 'f-fold');
    expect(pkg.projection.assets.filter((a) => a.status === 'case-mismatch').map((a) => a.key)).toEqual(['OD-002', 'OD-003']);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expectCanonical(w, pkg);
    expect(stored(w).find((r) => r.key === 'OD-003')!.real_path).toBe(pkg.docs[2]!.onDisk);
  });

  it('content that is not the declared type is download-only, decided by sniffing the stored bytes', async () => {
    const { w, pkg } = await honest(['ok', 'html'], 'f-sniff');
    expect(pkg.projection.assets.find((a) => a.key === 'OD-002')).toMatchObject({ status: 'verified', download_only: 1 });
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expectCanonical(w, pkg);
  });

  it('a mixed case equals the canonical projection and verifies, published or not', async () => {
    const { w, pkg } = await honest(['ok', 'missing', 'case', 'html', 'nfd'], 'f-mixed');
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expectCanonical(w, pkg);
    publish(w.db, 'case-a', pkg.identity.resultsVersion);
    expect(await w.store.verifyVersion({ caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion })).toMatchObject({ ok: true });
  });
});

describe('a claimed status is never evidence', () => {
  it('refuses a projection that calls an original verified when this case never uploaded it (an operator flag)', async () => {
    const w = world(), claimed = await originalsPackage('case-a', 'f-claim', ['ok', 'ok']);
    const result = await stage(w, claimed);
    expect(result).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect((result as { detail: string[] }).detail.join('\n')).toMatch(/asset OD-001 differs/);
    none(w);
  });

  it('refuses the same claim when only ANOTHER case holds those exact bytes, and accepts the honest unavailable projection', async () => {
    const w = world(), claimed = await originalsPackage('case-a', 'f-other', ['ok', 'ok']), honestMissing = await originalsPackage('case-a', 'f-other', ['missing', 'missing']);
    expect(claimed.identity).toEqual(honestMissing.identity);
    await provide(w, 'case-b', claimed.uploads);
    expect(w.db.rows('SELECT * FROM rs_original')).toHaveLength(2);
    expect(await stage(w, claimed)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    none(w);
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((r) => r.status)).toEqual(['unavailable', 'unavailable']);
    expect(w.db.rows('SELECT * FROM rs_case_original WHERE case_id = ?', 'case-b')).toHaveLength(2);
  });

  it('an association under another asset id does not make this asset’s original present', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'f-asset', ['ok', 'ok']), honestMissing = await originalsPackage('case-a', 'f-asset', ['missing', 'ok']);
    await provide(w, 'case-a', [{ ...pkg.uploads[0]!, ref: 'a1' }, pkg.uploads[1]!]);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((r) => [r.key, r.status])).toEqual([['OD-001', 'unavailable'], ['OD-002', 'verified']]);
  });

  it('a wrong-case name is a case mismatch, never verified, even when the claim says verified', async () => {
    const w = world(), claimed = await originalsPackage('case-a', 'f-wrongcase', ['ok', 'ok']), folded = await originalsPackage('case-a', 'f-wrongcase', ['ok', 'case']);
    await provide(w, 'case-a', folded.uploads);
    expect(await stage(w, claimed)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(await stage(w, folded)).toMatchObject({ kind: 'stored' });
    expectCanonical(w, folded);
  });

  it('two folded names for one path are ambiguous, as in the case folder: unavailable, not a guess', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'f-ambiguous', ['case']), honestMissing = await originalsPackage('case-a', 'f-ambiguous', ['missing']);
    const other = pdf('f-ambiguous-other');
    await provide(w, 'case-a', [pkg.uploads[0]!, { ref: 'x1', filename: pkg.docs[0]!.onDisk.replace('LETTER', 'Letter'), mediaType: 'application/pdf', bytes: other }]);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    expect(stored(w)[0]).toMatchObject({ status: 'unavailable', real_path: null, sha256: null });
  });
});

describe('a genuine digest mismatch stays fail-closed', () => {
  it('refuses, as integrity, an original whose bytes are not the indexed ones, whatever status is claimed', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'f-digest', ['ok', 'ok']), honestMissing = await originalsPackage('case-a', 'f-digest', ['missing', 'ok']);
    await provide(w, 'case-a', [{ ...pkg.uploads[0]!, bytes: pdf('not the indexed bytes') }, pkg.uploads[1]!]);
    for (const claim of [pkg, honestMissing]) {
      const result = await stage(w, claim);
      expect(result).toMatchObject({ kind: 'refused', reason: 'integrity' });
      expect((result as { detail: string[] }).detail.join('\n')).toContain('OD-001');
    }
    none(w);
  });

  it('refuses an original changed at rest in R2, and treats one deleted from R2 as honestly unavailable', async () => {
    const { w, pkg } = await honest(['ok', 'ok'], 'f-rest');
    const honestMissing = await originalsPackage('case-a', 'f-rest', ['missing', 'ok']);
    const key = `orig/${shaOf(pkg.docs[0]!.bytes)}`;
    w.bucket.tamper(key, (b) => { b[b.length - 2]! ^= 1; return b; });
    expect(await stage(w, pkg)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    none(w);
    w.bucket.objects.delete(key);
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((r) => r.status)).toEqual(['unavailable', 'verified']);
  });

  it('still refuses a forged row when every original is genuinely present, for that row alone', async () => {
    const { w, pkg } = await honest(['ok', 'ok'], 'f-forged');
    const d0 = pkg.projection.documents[0]!;
    const forged = { ...pkg.projection, documents: [{ ...d0, row_json: JSON.stringify({ ...JSON.parse(d0.row_json), subject: 'forged subject' }) }, ...pkg.projection.documents.slice(1)] };
    const result = await stage(w, pkg, { projection: forged });
    expect(result).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect((result as { detail: string[] }).detail).toEqual(['document OD-001 differs from the package']);
  });
});

describe('verifyVersion and the stored model stand on the same verified facts', () => {
  it('an original uploaded after an honest unavailable import does not make the immutable version unverifiable', async () => {
    const w = world(), honestMissing = await originalsPackage('case-a', 'f-late', ['missing', 'ok']), full = await originalsPackage('case-a', 'f-late', ['ok', 'ok']);
    await provide(w, 'case-a', [full.uploads[1]!]);
    expect(await stage(w, honestMissing)).toMatchObject({ kind: 'stored' });
    publish(w.db, 'case-a', honestMissing.identity.resultsVersion);
    await provide(w, 'case-a', [full.uploads[0]!]);
    expect(await w.store.verifyVersion({ caseId: ids.caseA, resultsVersion: honestMissing.identity.resultsVersion })).toMatchObject({ ok: true });
  });

  it('a verified original changed or removed after import fails verification', async () => {
    const { w, pkg } = await honest(['ok', 'ok'], 'f-later');
    const scope = { caseId: ids.caseA, resultsVersion: pkg.identity.resultsVersion };
    await stage(w, pkg);
    publish(w.db, 'case-a', scope.resultsVersion);
    expect(await w.store.verifyVersion(scope)).toMatchObject({ ok: true });
    w.bucket.tamper(`orig/${shaOf(pkg.docs[0]!.bytes)}`, (b) => { b[b.length - 2]! ^= 1; return b; });
    expect(await w.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
    w.bucket.objects.delete(`orig/${shaOf(pkg.docs[0]!.bytes)}`);
    expect(await w.store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
  });

  it('rows rewritten together with their digest to call a never-uploaded original verified do not verify', async () => {
    const w = world(), pkg = await originalsPackage('case-a', 'f-rewrite', ['missing', 'ok']);
    await provide(w, 'case-a', [pkg.uploads[0]!]);
    const rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    publish(w.db, 'case-a', rv);
    const missing = pkg.docs[0]!, sha = shaOf(missing.bytes);
    const claimed = JSON.stringify({ ...JSON.parse(w.db.rows<{ row_json: string }>("SELECT row_json FROM rs_asset WHERE asset_key = 'OD-001'")[0]!.row_json), status: 'verified', real_path: missing.path, sha256: sha, size: missing.bytes.byteLength });
    w.db.exec("UPDATE rs_asset SET row_json = ? WHERE asset_key = 'OD-001'", claimed);
    const docs = w.db.rows<{ ref: string; ord: number; row_json: string; state_json: string; attachments_json: string }>('SELECT ref, ord, row_json, state_json, attachments_json FROM rs_document');
    const assets = w.db.rows<{ row_json: string }>('SELECT row_json FROM rs_asset').map((r) => JSON.parse(r.row_json));
    const seeds = w.db.rows<{ ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }>('SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM rs_seed');
    const list = w.db.rows<{ list_json: string }>('SELECT list_json FROM rs_document ORDER BY ord').map((r) => JSON.parse(r.list_json));
    const { overview } = w.db.rows<{ overview: string }>('SELECT overview FROM rs_results_version')[0]!;
    w.db.exec('UPDATE rs_results_version SET read_model_sha256 = ?', readModelDigest({ documents: docs, assets, seeds, chronologyJson: JSON.stringify(list), overview, expect: JSON.stringify(pkg.projection.expect) }));
    expect(await world(w).store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
  });
});

describe('plumbing the existing fixtures need: honest facts for the package they stage', () => {
  it('provideOriginals gives the old two-document fixture the canonical all-verified projection', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'f-plumbing');
    await provideOriginals(w, 'case-a', pkg);
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expect(stored(w).map((r) => [r.status, r.download_only])).toEqual([['verified', 0], ['verified', 0]]);
  });
});
