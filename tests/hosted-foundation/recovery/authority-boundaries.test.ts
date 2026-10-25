import { describe, expect, it } from 'vitest';
import { applyRestore, exportCase, planRestore, verifyExport } from '../../../src/lib/recovery/hosted/index.ts';
import { canonicalJson, sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { CaseOperation, ResultsVersion } from '../../../src/lib/server/runtime/contracts.ts';
import { CASE, RV, enc, lookup, restoreDeps, target, world } from './world.ts';

const req = { caseId: CASE, exportId: 'boundary-export', includeUserWork: true };
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e));
async function exported() {
  const w = world(); const r = await exportCase(w.deps, req);
  return { w, r, ref: { caseId: CASE, exportId: req.exportId, expectedManifestSha256: r.manifestSha256 } };
}
const OTHER = ('sha256:' + 'e'.repeat(64)) as ResultsVersion;

describe('current per-version visibility', () => {
  it.each(['missing', 'standin', 'malformed'] as const)('%s policy is unavailable before any authority or storage call', async (mode) => {
    const { w, ref } = await exported(); const tg = target();
    w.objects.gets.length = 0;
    w.deps.visibility = mode === 'missing' ? null : mode === 'malformed' ? {} as never : w.deps.visibility;
    if (mode === 'standin') { w.deps.profile = 'production'; w.objects.kind = 'durable-private'; tg.objects.kind = 'durable-private'; }
    const before = w.calls.checkRevocation;
    for (const run of [
      () => exportCase(w.deps, { ...req, exportId: 'next' }), () => verifyExport(w.deps, ref),
      () => planRestore(restoreDeps(w, tg.t), ref),
      () => applyRestore(restoreDeps(w, tg.t), { ...ref, confirmedPlanSha256: '0'.repeat(64), operationId: 'missing-policy' }),
    ]) expect(await code(run())).toBe('recovery-unavailable');
    expect(w.calls.checkRevocation).toBe(before); expect(w.objects.gets).toEqual([]); expect(tg.log).toEqual([]);
  });

  it.each(['withdrawn', 'superseded', 'candidate'] as const)('%s results are denied despite a case grant, listing and historical publication', async (state) => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const p = await planRestore(deps, ref);
    // The authoritative policy changes independently of the old store listing and archived flags.
    const policy = w.deps.visibility!;
    policy.isVisible = async ({ identity, caseId, resultsVersion }) => {
      expect(identity).toBe(w.identity); expect(caseId).toBe(CASE); expect(resultsVersion).toBe(RV);
      return false;
    };
    w.objects.gets.length = 0;
    expect(await code(verifyExport(w.deps, ref))).toBe('not-found');
    expect(w.objects.gets).toEqual([lookup(w.objects, 'manifest.json')[0]]);
    expect(await code(planRestore(deps, ref))).toBe('not-found');
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: p.planSha256, operationId: state }))).toBe('not-found');
    expect(await code(exportCase(w.deps, { ...req, exportId: state }))).toBe('not-found');
    expect(tg.objects.map.size).toBe(0); expect(tg.log).toEqual([]);
    expect(w.identity.principal).not.toBeNull(); // this is version denial, not lack of a case grant
  });

  it.each(['preview', 'package', 'active', 'publication'] as const)('checks the %s identity even if other identities remain visible', async (field) => {
    const { w, r, ref } = await exported(); const manifest = structuredClone(r.manifest);
    if (field === 'preview') manifest.previews[0]!.resultsVersion = OTHER;
    if (field === 'package') manifest.resultsVersions[0]!.version.id = OTHER;
    if (field === 'active') manifest.source.activeVersion = OTHER;
    if (field === 'publication') manifest.source.publication = { kind: 'published', resultsVersion: OTHER };
    const bytes = enc(canonicalJson(manifest)); w.objects.map.set(lookup(w.objects, 'manifest.json')[0]!, bytes);
    w.objects.gets.length = 0;
    expect(await code(verifyExport(w.deps, { ...ref, expectedManifestSha256: await sha256Hex(bytes) }))).toBe('not-found');
    expect(w.objects.gets).toHaveLength(1);
  });

  it('fails closed on a missing identity, non-boolean policy approval, and policy faults', async () => {
    const { w, r, ref } = await exported();
    w.deps.visibility!.isVisible = async () => undefined as never;
    expect(await code(verifyExport(w.deps, ref))).toBe('not-found');
    w.deps.visibility!.isVisible = async () => { throw contractError('recovery-unavailable', true); };
    expect(await code(verifyExport(w.deps, ref))).toBe('recovery-unavailable');
    const manifest = structuredClone(r.manifest); delete (manifest.previews[0] as { resultsVersion?: ResultsVersion }).resultsVersion;
    const bytes = enc(canonicalJson(manifest)); w.objects.map.set(lookup(w.objects, 'manifest.json')[0]!, bytes);
    w.deps.visibility!.isVisible = async () => true;
    expect(await code(verifyExport(w.deps, { ...ref, expectedManifestSha256: await sha256Hex(bytes) }))).toBe('manifest-invalid');
  });

  it('withdrawal leaves separately scoped originals and independent user work usable, including an export with no results identities', async () => {
    const { w, ref } = await exported();
    w.deps.store.getCase = async () => ({ caseId: CASE, caseLabel: 'Synthetic', publication: { kind: 'withdrawn' }, href: '/c', documents: null });
    w.deps.store.activeVersionId = async () => null; w.deps.store.versionsOf = async () => [];
    expect(await code(verifyExport(w.deps, ref))).toBe('not-found');
    await w.identity.authorize({ caseId: CASE, operation: 'read-original' });
    const original = await w.deps.assets.get({ asset: { kind: 'original', caseId: CASE, assetId: 'orig-1' }, request: { method: 'GET', range: null, ifRange: null } });
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(w.originals.get('orig-1'));
    await w.identity.authorize({ caseId: CASE, operation: 'read' });
    expect(await w.deps.userWork.exportAll({ caseId: CASE })).toEqual(w.userExport);
    const fresh = await exportCase(w.deps, { ...req, exportId: 'independent' });
    expect(fresh.manifest.resultsVersions).toEqual([]); expect(fresh.manifest.previews).toEqual([]);
    expect(fresh.manifest.source.activeVersion).toBeNull();
    const independent = { caseId: CASE, exportId: 'independent', expectedManifestSha256: fresh.manifestSha256 };
    expect(await code(verifyExport(w.deps, independent))).toBe('resolved');
    const tg = target(); const deps = restoreDeps(w, tg.t); const p = await planRestore(deps, independent);
    const report = await applyRestore(deps, { ...independent, confirmedPlanSha256: p.planSha256, operationId: 'independent' });
    expect(report.ok).toBe(true); expect(report.userWork.imported?.rows).toBe(2);
  });
});

const readScopes: CaseOperation[] = ['read', 'read-original', 'read-preview'];
describe('release-boundary authority', () => {
  it.each(['verify-audit', 'plan-revision', 'plan-empty', 'plan-conflict', 'plan-audit'] as const)('revocation during %s releases no result', async (boundary) => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const revoke = () => { w.k.revoked = true; };
    if (boundary.endsWith('audit')) {
      const append = w.deps.audit.append.bind(w.deps.audit);
      w.deps.audit.append = async e => { const r = await append(e); if (e.action === (boundary === 'verify-audit' ? 'recovery.verify' : 'recovery.restore.plan') && w.calls.audit.filter(x => x.action === e.action).length === 2) revoke(); return r; };
    }
    if (boundary === 'plan-revision') { const read = tg.t.stateRevision; tg.t.stateRevision = async () => { const r = await read(); revoke(); return r; }; }
    if (boundary === 'plan-empty') { const read = tg.t.userWork.exportAll; tg.t.userWork.exportAll = async a => { const r = await read(a); revoke(); return r; }; }
    if (boundary === 'plan-conflict') { const get = tg.objects.get.bind(tg.objects); tg.objects.get = async k => { const r = await get(k); revoke(); return r; }; }
    expect(await code(boundary.startsWith('verify') ? verifyExport(w.deps, ref) : planRestore(deps, ref))).toBe('invalid-session');
    expect(tg.log).toEqual([]); expect(tg.objects.map.size).toBe(0);
  });

  it.each(readScopes)('rechecks the %s grant after the final verify and plan audit', async operation => {
    for (const action of ['recovery.verify', 'recovery.restore.plan']) {
      const { w, ref } = await exported(); const tg = target(); let release = false;
      const authorize = w.identity.authorize.bind(w.identity);
      w.identity.authorize = async a => { if (release && a.operation === operation) throw contractError('forbidden'); await authorize(a); };
      const append = w.deps.audit.append.bind(w.deps.audit);
      w.deps.audit.append = async e => { const r = await append(e); if (e.action === action && w.calls.audit.filter(x => x.action === action).length === 2) release = true; return r; };
      expect(await code(action === 'recovery.verify' ? verifyExport(w.deps, ref) : planRestore(restoreDeps(w, tg.t), ref))).toBe('forbidden');
      expect(release).toBe(true); expect(tg.log).toEqual([]);
      expect(w.calls.audit.at(-1)).toMatchObject({ action, outcome: 'denied', object: { caseId: CASE } });
    }
  });

  it.each(['verify', 'plan'] as const)('rechecks current visibility after the %s completion audit', async mode => {
    const { w, ref } = await exported(); const tg = target(); const action = mode === 'verify' ? 'recovery.verify' : 'recovery.restore.plan';
    const append = w.deps.audit.append.bind(w.deps.audit);
    w.deps.audit.append = async e => { const r = await append(e); if (e.action === action && w.calls.audit.filter(x => x.action === action).length === 2) w.deps.visibility!.isVisible = async () => false; return r; };
    expect(await code(mode === 'verify' ? verifyExport(w.deps, ref) : planRestore(restoreDeps(w, tg.t), ref))).toBe('not-found');
  });

  it('revocation during the final grant lookup still releases nothing', async () => {
    const { w, ref } = await exported(); const authorize = w.identity.authorize.bind(w.identity);
    w.identity.authorize = async a => { await authorize(a); if (a.operation === 'read-preview') w.k.revoked = true; };
    expect(await code(verifyExport(w.deps, ref))).toBe('invalid-session');
  });

  it.each(['revocation', 'grant', 'visibility'] as const)('%s lost during staged readback prevents import and keeps staged data', async mode => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); const p = await planRestore(deps, ref);
    const get = tg.objects.get.bind(tg.objects);
    tg.objects.get = async k => {
      const b = await get(k);
      if (tg.objects.map.size === p.stage.objects) {
        if (mode === 'revocation') w.k.revoked = true;
        if (mode === 'grant') w.k.denyWith = 'forbidden';
        if (mode === 'visibility') w.deps.visibility!.isVisible = async () => false;
      }
      return b;
    };
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: p.planSha256, operationId: mode }))).toBe(mode === 'revocation' ? 'invalid-session' : mode === 'grant' ? 'forbidden' : 'not-found');
    expect(tg.imports).toEqual([]); expect(tg.log).toEqual(['snapshot']); expect(tg.objects.map.size).toBe(p.stage.objects);
  });
});

it.each([...readScopes, 'write-user-work'] as const)('restore rechecks the specific %s grant immediately before import', async operation => {
  const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); const p = await planRestore(deps, ref);
  const authorize = w.identity.authorize.bind(w.identity); let readback = false;
  w.identity.authorize = async a => { if (readback && a.operation === operation) throw contractError('forbidden'); await authorize(a); };
  const get = tg.objects.get.bind(tg.objects);
  tg.objects.get = async k => { const b = await get(k); if (tg.objects.map.size === p.stage.objects) readback = true; return b; };
  expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: p.planSha256, operationId: 'grant-before-import' }))).toBe('forbidden');
  expect(readback).toBe(true); expect(tg.imports).toEqual([]); expect(tg.log).toEqual(['snapshot']);
});

it.each(['export', 'apply'] as const)('%s refuses release after audit-time revocation without rolling back committed data', async mode => {
  const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); const p = await planRestore(deps, ref);
  const action = mode === 'export' ? 'recovery.export' : 'recovery.restore.apply';
  const append = w.deps.audit.append.bind(w.deps.audit); let seen = 0;
  w.deps.audit.append = async e => { const r = await append(e); if (e.action === action && ++seen === 2) w.k.revoked = true; return r; };
  expect(await code(mode === 'export' ? exportCase(w.deps, { ...req, exportId: 'late-revocation' }) :
    applyRestore(deps, { ...ref, confirmedPlanSha256: p.planSha256, operationId: 'late-revocation' }))).toBe('invalid-session');
  expect(w.calls.audit.at(-1)).toMatchObject({ action, outcome: 'denied' });
  if (mode === 'apply') { expect(tg.imports).toHaveLength(1); expect(tg.objects.map.size).toBe(p.stage.objects); }
  else expect(lookup(w.objects, 'late-revocation/manifest.json')).toHaveLength(1);
});

it.each(['missing', 'size', 'sha', 'manifest'] as const)('a staged %s integrity failure preserves the empty target, snapshot and additive objects', async mode => {
  const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); const p = await planRestore(deps, ref);
  const get = tg.objects.get.bind(tg.objects);
  tg.objects.get = async k => {
    const b = await get(k);
    if (!b || tg.objects.map.size !== p.stage.objects || (mode === 'manifest' ? !k.endsWith('manifest.json') : !k.includes('/blobs/'))) return b;
    if (mode === 'missing') return null;
    if (mode === 'size') return b.slice(1);
    b[0] ^= 1; return b;
  };
  expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: p.planSha256, operationId: mode }))).toBe('restore-failed');
  expect(tg.imports).toEqual([]); expect(tg.log).toEqual(['snapshot']); expect(tg.snaps.size).toBe(1);
  expect(tg.objects.map.size).toBe(p.stage.objects);
  expect((await tg.t.userWork.exportAll({ caseId: tg.t.caseId })).tables[0]!.rows).toEqual([]);
  // A transient read fault does not poison a retry: staged bytes were not deleted or replaced.
  tg.objects.get = get;
  const again = await planRestore(restoreDeps(w, tg.t), ref); expect(again.planSha256).toBe(p.planSha256);
  const report = await applyRestore(restoreDeps(w, tg.t), { ...ref, confirmedPlanSha256: again.planSha256, operationId: mode });
  expect(report.ok).toBe(true); expect(report.objects.alreadyPresent).toBe(p.stage.objects); expect(tg.imports).toHaveLength(1);
});
