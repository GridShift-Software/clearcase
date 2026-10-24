// GRS-115 fix round 1: one regression class per written Medium finding (M1-M6) of the independent source review.
// UNIT evidence only: D1 and R2 are the test doubles in ./doubles.ts, not Cloudflare. Each test names the finding it
// pins; the assertions fail against the adapter as first prepared (4db2d20a) and pass with the fix.
import { describe, expect, it } from 'vitest';
import { createCloudResults, type StorageEvent } from '../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { storageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';
import { readModelDigest } from '../../../src/lib/local-case/project.server.ts';
import { id, type CaseRevision } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { AssetRef } from '../../../src/lib/server/runtime/contracts.ts';
import { BUDGETS, GET, deployment, grantedIdentity, ids, pdf, publish, shaOf, syntheticPackage } from './fixture.ts';

const now = () => new Date('2001-01-01T00:00:00Z');
const allow = async () => {};
const QUOTAS = {
  maxUploadsPerCase: 50, maxOriginalBytesPerCase: 64 << 20, maxOriginalBytesPerClient: 256 << 20, maxPutAttemptsPerUpload: 5,
  maxVersionsPerCase: 20, maxPackageBytesPerCase: 64 << 20, maxPackageBytesPerClient: 256 << 20, maxStagingAttemptsPerCase: 50,
};
type Mutation = { clientId: string; caseId: string; capability: string; step: string; operationId: string };
interface Options { dep?: ReturnType<typeof deployment>; budgets?: typeof BUDGETS; quotas?: typeof QUOTAS | null; authorize?: ((m: Mutation) => Promise<void>) | null; grants?: string[] }

function world(a: Options = {}) {
  const dep = a.dep ?? deployment('client-a', ['case-a', 'case-b']);
  const bindings = { db: dep.db, bucket: dep.bucket };
  const budgets = a.budgets ?? BUDGETS;
  const who = grantedIdentity(ids.clientA, a.grants ?? ['case-a', 'case-b']);
  const events: StorageEvent[] = [];
  const calls: Mutation[] = [];
  const authorize = a.authorize === undefined ? async (m: Mutation) => { calls.push(m); } : a.authorize;
  // The writers take the capability callback and the quotas; spread as plain objects so the same file runs against both revisions.
  const writer: Record<string, unknown> = { bindings, clientId: ids.clientA, budgets, now, quotas: a.quotas === undefined ? QUOTAS : a.quotas };
  if (authorize) writer.authorize = authorize;
  const results = createCloudResults({
    bindings, clientId: ids.clientA, budgets, identity: who.identity,
    record: async (e) => { events.push(e); },
    stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision,
  });
  return { ...dep, ...results, staging: createResultsStaging(writer as never), intake: createOriginalIntake(writer as never), who, events, calls };
}
type World = ReturnType<typeof world>;
const declaration = (caseId: string, operationId: string, assetId: string, bytes: Uint8Array, filename = `${assetId}.pdf`) =>
  ({ caseId: id('case', caseId), operationId, assetId, filename, mediaType: 'application/pdf', size: bytes.byteLength, sha256: shaOf(bytes) });
const original = (caseId: string, assetId: string): AssetRef => ({ kind: 'original', caseId: id('case', caseId), assetId });
async function upload(w: World, caseId: string, assetId: string, bytes: Uint8Array, operationId = `op-${caseId}-${assetId}`) {
  expect(await w.intake.declare(declaration(caseId, operationId, assetId, bytes))).toMatchObject({ kind: 'declared' });
  expect(await w.intake.put({ caseId: id('case', caseId), operationId, bytes })).toMatchObject({ kind: 'stored' });
  return w.intake.finalize({ caseId: id('case', caseId), operationId });
}
const stage = (w: World, pkg: Awaited<ReturnType<typeof syntheticPackage>>, over: Record<string, unknown> = {}) =>
  w.staging.stage({ caseId: ids.caseA, operationId: 'import-1', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection, ...over });
const objects = (w: World) => [...w.bucket.objects.keys()].filter((k) => k !== 'identity/client.json');
const counted = (w: World) => { const n = { head: 0, put: 0 }; const head = w.bucket.head.bind(w.bucket), put = w.bucket.put.bind(w.bucket); w.bucket.head = async (k) => { n.head++; return head(k); }; w.bucket.put = async (k, v, o) => { n.put++; return put(k, v, o); }; return n; };

describe('M1: an original is bound by its own authorized upload, never by a known SHA-256', () => {
  it('refuses to finalize case-b’s declaration of a hash that only case-a uploaded, and binds nothing', async () => {
    const w = world(), bytes = pdf('m1-shared');
    expect(await upload(w, 'case-a', 'a1', bytes)).toMatchObject({ kind: 'finalized' });
    expect(await w.intake.declare(declaration('case-b', 'op-b', 'b1', bytes))).toMatchObject({ kind: 'declared' });
    const finalized = await w.intake.finalize({ caseId: ids.caseB, operationId: 'op-b' });
    expect(finalized).toMatchObject({ kind: 'refused' });
    expect(w.db.rows('SELECT * FROM rs_case_original WHERE case_id = ?', 'case-b')).toEqual([]);
    await expect(w.assets.get({ asset: original('case-b', 'b1'), request: GET })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('gives case-b no sign that another case already holds the same bytes', async () => {
    const w = world(), bytes = pdf('m1-oracle');
    await upload(w, 'case-a', 'a1', bytes);
    await w.intake.declare(declaration('case-b', 'op-b', 'b1', bytes));
    expect(await w.intake.put({ caseId: ids.caseB, operationId: 'op-b', bytes })).toEqual({ kind: 'stored', repeated: false });
    expect(await w.intake.finalize({ caseId: ids.caseB, operationId: 'op-b' })).toEqual({ kind: 'finalized', repeated: false });
  });
});

describe('M2: inconsistent budgets are refused before anything is written', () => {
  it('rejects a configuration whose original bound exceeds what can be buffered and verified', () => {
    expect(storageBudgets({ ...BUDGETS, maxOriginalBytes: BUDGETS.maxBufferedObjectBytes + 1 })).toBeNull();
    expect(storageBudgets({ ...BUDGETS, maxPackageFileBytes: BUDGETS.maxPackageBytes + 1 })).toBeNull();
    expect(storageBudgets(BUDGETS)).toEqual(BUDGETS);
  });

  it('stores no body that finalize could never accept when a raw budget object is inconsistent', async () => {
    const w = world({ budgets: { ...BUDGETS, maxOriginalBytes: 1000, maxBufferedObjectBytes: 10 } }), bytes = pdf('m2');
    await expect(w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.db.rows('SELECT * FROM rs_original_upload')).toEqual([]);
    expect(objects(w)).toEqual([]);
  });
});

describe('M3: hosted download headers keep the serve policy’s filename hardening', () => {
  async function served(filename: string) {
    const w = world(), bytes = pdf('m3');
    await upload(w, 'case-a', 'a1', bytes);
    w.db.exec('UPDATE rs_case_original SET filename = ? WHERE case_id = ? AND asset_id = ?', filename, 'case-a', 'a1');
    return (await w.assets.get({ asset: original('case-a', 'a1'), request: GET })).headers.get('content-disposition')!;
  }
  it('drops bidi overrides and controls and gives a valid ASCII fallback beside the RFC 8187 form', async () => {
    const cd = await served('inv\u202Efdp.exe it\'s \u2066x\u2069.pdf');
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(cd).not.toMatch(/%E2%80%(?:AE|A6|A9)/i);
    expect(cd).toContain('%27');
    expect(cd).not.toContain("'s");
  });
  it('cannot be turned into a header injection or a path', async () => {
    const cd = await served('../x"\r\nSet-Cookie: a=b;\\.pdf');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).not.toContain('/');
    expect(cd).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''/);
  });
  it('refuses to declare a filename that hides its extension with a bidi override', async () => {
    const w = world();
    expect(await w.intake.declare(declaration('case-a', 'op-1', 'a1', pdf('m3-declare'), 'invoice\u202Efdp.exe'))).toEqual({ kind: 'refused', reason: 'invalid-declaration' });
  });
});

describe('M4: the projection is derived from the verified package bytes, never trusted', () => {
  const forge = (p: Awaited<ReturnType<typeof syntheticPackage>>['projection']) => {
    const d0 = p.documents[0]!;
    const forged = { ...JSON.parse(d0.row_json), subject: 'forged subject' };
    const list = JSON.parse(p.chronologyJson) as { ref: string; subject: string }[];
    list.find((e) => e.ref === d0.ref)!.subject = 'forged subject';
    return { ...p, documents: [{ ...d0, row_json: JSON.stringify(forged) }, ...p.documents.slice(1)], chronologyJson: JSON.stringify(list) };
  };
  it('refuses a self-consistent projection that does not describe the package', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'm4-forged');
    expect(await stage(w, pkg, { projection: forge(pkg.projection) })).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
    expect(objects(w)).toEqual([]);
  });
  it('refuses another package’s projection of the same shape', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'm4-one'), stale = await syntheticPackage('case-a', 'm4-two');
    expect(await stage(w, pkg, { projection: stale.projection })).toMatchObject({ kind: 'refused', reason: 'inconsistent-projection' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });
  const tamper: [string, string][] = [
    ['a document state', "UPDATE rs_document SET state_json = replace(state_json, 'present', 'missing') WHERE ref = 'OD-001'"],
    ['a list entry', "UPDATE rs_document SET list_json = replace(list_json, 'Synthetic', 'Forged') WHERE ref = 'OD-002'"],
    ['an asset row', "UPDATE rs_asset SET row_json = replace(row_json, 'verified', 'missing')"],
  ];
  for (const [what, sql] of tamper) it(`refuses to serve ${what} that changed in D1`, async () => {
    const w = world(), pkg = await syntheticPackage('case-a', `m4-${what}`), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    await stage(w, pkg);
    publish(w.db, 'case-a', rv);
    expect((await w.store.documentRows(scope)).rows).toHaveLength(2);
    const fresh = world({ dep: w });
    expect(w.db.sqlite.prepare(sql).run().changes).toBeGreaterThan(0);
    await expect(fresh.store.documentRows(scope)).rejects.toMatchObject({ code: 'integrity' });
    await expect(fresh.store.packageFile({ ...scope, path: 'manifest.json' })).resolves.toEqual(pkg.files.get('manifest.json'));
  });
  it('catches rows rewritten together with their stored digest when the version is verified against its bytes', async () => {
    const w = world(), pkg = await syntheticPackage('case-a', 'm4-digest'), rv = pkg.identity.resultsVersion, scope = { caseId: ids.caseA, resultsVersion: rv };
    await stage(w, pkg);
    publish(w.db, 'case-a', rv);
    w.db.exec("UPDATE rs_document SET state_json = replace(state_json, 'present', 'missing') WHERE ref = 'OD-001'");
    const docs = w.db.rows<{ ref: string; ord: number; row_json: string; state_json: string; attachments_json: string }>('SELECT ref, ord, row_json, state_json, attachments_json FROM rs_document');
    const assets = w.db.rows<{ asset_key: string; row_json: string }>('SELECT asset_key, row_json FROM rs_asset').map((r) => JSON.parse(r.row_json));
    const seeds = w.db.rows<{ ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }>('SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM rs_seed');
    const list = w.db.rows<{ list_json: string }>('SELECT list_json FROM rs_document ORDER BY ord').map((r) => JSON.parse(r.list_json));
    const version = w.db.rows<{ overview: string }>('SELECT overview FROM rs_results_version')[0]!;
    const { expect: e } = pkg.projection;
    w.db.exec('UPDATE rs_results_version SET read_model_sha256 = ?', readModelDigest({ documents: docs, assets, seeds, chronologyJson: JSON.stringify(list), overview: version.overview, expect: JSON.stringify(e) }));
    expect(await world({ dep: w }).store.verifyVersion(scope)).toMatchObject({ ok: false, reason: 'integrity' });
  });
});

describe('M5: every mutation needs the injected capability authorization, and a missing one denies', () => {
  const denied: (m: Mutation) => Promise<void> = async () => { throw contractError('forbidden'); };
  it('writes no row and no object when the capability is denied', async () => {
    const w = world({ authorize: denied }), bytes = pdf('m5'), pkg = await syntheticPackage('case-a', 'm5');
    await expect(w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.intake.finalize({ caseId: ids.caseA, operationId: 'op-1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(stage(w, pkg)).rejects.toMatchObject({ code: 'forbidden' });
    for (const t of ['rs_original_upload', 'rs_case_original', 'rs_original', 'rs_results_version']) expect(w.db.rows(`SELECT * FROM ${t}`), t).toEqual([]);
    expect(objects(w)).toEqual([]);
  });
  it('denies every mutation of a factory built without the callback', async () => {
    const w = world({ authorize: null }), bytes = pdf('m5-missing'), pkg = await syntheticPackage('case-a', 'm5-missing');
    await expect(w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(stage(w, pkg)).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.db.rows('SELECT * FROM rs_original_upload')).toEqual([]);
    expect(objects(w)).toEqual([]);
  });
  it('denies a callback that resolves false, and reports a callback fault as unavailable, never as allowed', async () => {
    const no = world({ authorize: (async () => false) as never }), bytes = pdf('m5-false');
    await expect(no.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).rejects.toMatchObject({ code: 'forbidden' });
    const down = world({ authorize: async () => { throw new Error('identity service down'); } });
    await expect(down.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(no.db.rows('SELECT * FROM rs_original_upload')).toEqual([]);
  });
  it('asks per step, with the deployment’s client, the case and the capability, before the step’s first write', async () => {
    const seen: Mutation[] = [];
    const w = world({ authorize: async (m) => { seen.push(m); if (m.step === 'put') throw contractError('forbidden'); } }), bytes = pdf('m5-steps');
    await w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes));
    await expect(w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).rejects.toMatchObject({ code: 'forbidden' });
    expect(objects(w)).toEqual([]);
    await expect(w.intake.finalize({ caseId: ids.caseA, operationId: 'op-1' })).resolves.toMatchObject({ kind: 'refused' });
    const pkg = await syntheticPackage('case-a', 'm5-steps');
    await stage(w, pkg);
    expect(seen).toEqual([
      { clientId: 'client-a', caseId: 'case-a', capability: 'original.upload', step: 'declare', operationId: 'op-1' },
      { clientId: 'client-a', caseId: 'case-a', capability: 'original.upload', step: 'put', operationId: 'op-1' },
      { clientId: 'client-a', caseId: 'case-a', capability: 'original.upload', step: 'finalize', operationId: 'op-1' },
      { clientId: 'client-a', caseId: 'case-a', capability: 'results.import', step: 'stage', operationId: 'import-1' },
    ]);
  });
});

describe('M6: cumulative quotas are reserved in D1 before any provider write', () => {
  it('fails closed without quotas', async () => {
    const w = world({ quotas: null });
    await expect(w.intake.declare(declaration('case-a', 'op-1', 'a1', pdf('m6-none')))).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(stage(w, await syntheticPackage('case-a', 'm6-none'))).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.db.rows('SELECT * FROM rs_original_upload')).toEqual([]);
  });
  it('counts every declared upload against the case’s uploads, the case’s bytes and the client’s bytes', async () => {
    const small = pdf('m6-a'), size = small.byteLength;
    const count = world({ quotas: { ...QUOTAS, maxUploadsPerCase: 2 } });
    await count.intake.declare(declaration('case-a', 'op-1', 'a1', pdf('m6-1')));
    await count.intake.declare(declaration('case-a', 'op-2', 'a2', pdf('m6-2')));
    expect(await count.intake.declare(declaration('case-a', 'op-1', 'a1', pdf('m6-1')))).toEqual({ kind: 'declared', repeated: true });
    expect(await count.intake.declare(declaration('case-a', 'op-3', 'a3', pdf('m6-3')))).toEqual({ kind: 'refused', reason: 'over-quota' });
    expect(await count.intake.declare(declaration('case-b', 'op-b', 'b1', pdf('m6-4')))).toMatchObject({ kind: 'declared' });
    const bytes = world({ quotas: { ...QUOTAS, maxOriginalBytesPerCase: size + 8 } });
    await bytes.intake.declare(declaration('case-a', 'op-1', 'a1', small));
    expect(await bytes.intake.declare(declaration('case-a', 'op-2', 'a2', pdf('m6-b')))).toEqual({ kind: 'refused', reason: 'over-quota' });
    const client = world({ quotas: { ...QUOTAS, maxOriginalBytesPerClient: size + 8 } });
    await client.intake.declare(declaration('case-a', 'op-1', 'a1', small));
    expect(await client.intake.declare(declaration('case-b', 'op-2', 'b1', pdf('m6-c')))).toEqual({ kind: 'refused', reason: 'over-quota' });
    expect(client.db.rows('SELECT * FROM rs_original_upload')).toHaveLength(1);
  });
  it('does not let a retry reset the put budget or reach the bucket past it', async () => {
    const w = world({ quotas: { ...QUOTAS, maxPutAttemptsPerUpload: 2 } }), bytes = pdf('m6-put'), n = counted(w);
    w.bucket.setRaw(`orig/${shaOf(bytes)}`, pdf('someone else'));
    await w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes));
    const calls = () => n.head + n.put;
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).toEqual({ kind: 'refused', reason: 'conflicting-object' });
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).toEqual({ kind: 'refused', reason: 'conflicting-object' });
    const before = calls();
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).toEqual({ kind: 'refused', reason: 'over-quota' });
    expect(calls()).toBe(before);
    // declaring the same operation again is idempotent and gives no new attempts
    expect(await w.intake.declare(declaration('case-a', 'op-1', 'a1', bytes))).toEqual({ kind: 'declared', repeated: true });
    expect(await w.intake.put({ caseId: ids.caseA, operationId: 'op-1', bytes })).toEqual({ kind: 'refused', reason: 'over-quota' });
  });
  it('caps versions per case and staging attempts per case, retries included, before any object is written', async () => {
    const versions = world({ quotas: { ...QUOTAS, maxVersionsPerCase: 1 } }), one = await syntheticPackage('case-a', 'm6-v1'), two = await syntheticPackage('case-a', 'm6-v2');
    expect(await stage(versions, one)).toMatchObject({ kind: 'stored' });
    const before = objects(versions).length;
    expect(await stage(versions, two, { operationId: 'import-2' })).toMatchObject({ kind: 'refused', reason: 'over-quota' });
    expect(objects(versions)).toHaveLength(before);
    expect(versions.db.rows('SELECT * FROM rs_results_version')).toHaveLength(1);

    const attempts = world({ quotas: { ...QUOTAS, maxStagingAttemptsPerCase: 2 } }), n = counted(attempts);
    for (const op of ['import-1', 'import-2']) { attempts.db.failNext = /INSERT INTO rs_document/; await expect(stage(attempts, one, { operationId: op })).rejects.toMatchObject({ code: 'storage-unavailable' }); }
    const puts = n.put;
    expect(await stage(attempts, one, { operationId: 'import-3' })).toMatchObject({ kind: 'refused', reason: 'over-quota' });
    expect(n.put).toBe(puts);
    expect(attempts.db.rows<{ attempt: number }>('SELECT attempt FROM rs_results_version')).toEqual([{ attempt: 2 }]);
  });
  it('counts package bytes against the case and the client', async () => {
    const pkg = await syntheticPackage('case-a', 'm6-bytes'), total = [...pkg.files.values()].reduce((s, b) => s + b.byteLength, 0);
    const w = world({ quotas: { ...QUOTAS, maxPackageBytesPerCase: total, maxPackageBytesPerClient: total } });
    expect(await stage(w, pkg)).toMatchObject({ kind: 'stored' });
    expect(await stage(w, await syntheticPackage('case-a', 'm6-bytes-2'), { operationId: 'import-2' })).toMatchObject({ kind: 'refused', reason: 'over-quota' });
  });
});
