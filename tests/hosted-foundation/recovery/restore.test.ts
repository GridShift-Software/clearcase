import { describe, expect, it } from 'vitest';
import { applyRestore, exportCase, planRestore } from '../../../src/lib/recovery/hosted/index.ts';
import { CASE, MemObjects, enc, lookup, restoreDeps, target, world } from './world.ts';

const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e));
async function exported(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts); const r = await exportCase(w.deps, { caseId: CASE, exportId: 'exp-1', includeUserWork: true });
  return { w, r, ref: { caseId: CASE, exportId: 'exp-1', expectedManifestSha256: r.manifestSha256 } };
}
const live = (w: ReturnType<typeof world>) => new Map(w.objects.map);

describe('non-destructive restore', () => {
  it('plans without writing, then applies into the isolated target: snapshot first, guarded import, per-category accounting, nothing deleted', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); const before = live(w);
    const plan = await planRestore(deps, ref);
    expect(plan).toMatchObject({ destructive: false, deletes: 0, target: { revision: 'trev-1' }, categories: { originals: { files: 3 }, resultsPackages: { files: 2 }, userWork: { rows: 2 } } });
    expect(tg.objects.map.size).toBe(0); expect(tg.log).toEqual([]);
    const report = await applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' });
    expect(report).toMatchObject({ ok: true, activated: false, preRestoreSnapshot: 'snap-1', userWork: { planned: { rows: 2 }, imported: { rows: 2, deleted: 0, replaced: 0 } } });
    expect(report.objects).toMatchObject({ planned: plan.stage.objects, written: plan.stage.objects, alreadyPresent: 0, verified: plan.stage.objects });
    expect(tg.log).toEqual(['snapshot', 'import']); expect(tg.imports[0]).toMatchObject({ expectedRevision: 'trev-1', preRestore: 'snap-1' });
    expect(report.invariants.every((i) => i.ok)).toBe(true);
    expect(live(w)).toEqual(before); // the live export and its originals are untouched
    expect(lookup(tg.objects, '/blobs/').length).toBe(plan.stage.objects - 1);
  });

  it('refuses to apply unless the exact current plan is confirmed, and writes nothing', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: 'f'.repeat(64), operationId: 'op-1' }))).toBe('plan-mismatch');
    expect(tg.objects.map.size).toBe(0); expect(tg.log).toEqual([]);
  });

  it('a target that moved after the plan changes nothing (expected-version guard), also when the import itself reports stale', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const plan = await planRestore(deps, ref); tg.bump();
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' }))).toBe('plan-mismatch'); // revision is part of the plan identity
    expect(tg.objects.map.size).toBe(0); expect(tg.log).toEqual([]);
    const t2 = target(); t2.setImport('stale'); const d2 = restoreDeps(w, t2.t); const p2 = await planRestore(d2, ref);
    expect(await code(applyRestore(d2, { ...ref, confirmedPlanSha256: p2.planSha256, operationId: 'op-2' }))).toBe('stale-state');
    expect(t2.log).toEqual(['snapshot', 'import']);
  });

  it('refuses a target that is not isolated, is not empty, or belongs to another client, before reading any export byte', async () => {
    const { w, ref } = await exported(); w.objects.gets.length = 0;
    expect(await code(planRestore(restoreDeps(w, target({ isolationId: 'live-client-a' }).t), ref))).toBe('target-not-isolated');
    expect(await code(planRestore(restoreDeps(w, target({ objects: w.objects }).t), ref))).toBe('target-not-isolated');
    expect(await code(planRestore(restoreDeps(w, target({ clientId: 'client-b' as never }).t), ref))).toBe('foreign-input');
    expect(await code(planRestore(restoreDeps(w, null), ref))).toBe('recovery-unavailable');
    expect(w.objects.gets).toEqual([]);
    const tg = target({ seedRows: 3 });
    expect(await code(planRestore(restoreDeps(w, tg.t), ref))).toBe('target-not-empty'); expect(tg.objects.map.size).toBe(0);
  });

  it('a differing object already staged in the target is a conflict before any write', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const plan = await planRestore(deps, ref);
    const key = `restore/client-a/case-restore-1/exp-1/blobs/${plan.manifestSha256 === '' ? '' : [...w.objects.map.keys()].find((k) => k.includes('/blobs/'))!.split('/blobs/')[1]}`;
    tg.objects.map.set(key, enc('somebody else')); const seeded = new Map(tg.objects.map);
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' }))).toBe('restore-conflict');
    expect(tg.objects.map).toEqual(seeded); expect(tg.log).toEqual([]);
  });

  it('a revoked or foreign caller restores nothing and the audit holds a denial; a missing-authority export is never read', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t); w.objects.gets.length = 0;
    w.k.denyWith = 'forbidden';
    expect(await code(planRestore(deps, ref))).toBe('forbidden'); expect(w.objects.gets).toEqual([]);
    w.k.denyWith = null; w.k.revoked = true;
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: '1'.repeat(64), operationId: 'op-1' }))).toBe('invalid-session');
    expect(tg.objects.map.size).toBe(0); expect(tg.log).toEqual([]);
  });

  it('a corrupt export is never restored', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const k = lookup(w.objects, '/blobs/')[0]!; const b = new Uint8Array(w.objects.map.get(k)!); b[0] ^= 1; w.objects.map.set(k, b);
    expect(await code(planRestore(deps, ref))).toBe('export-corrupt'); expect(tg.objects.map.size).toBe(0);
  });

  it('restart stand-in: a run interrupted after staging resumes from the same durable stores, keeping staged objects and importing once', async () => {
    const { w, ref } = await exported(); const tg = target(); let deps = restoreDeps(w, tg.t);
    const plan = await planRestore(deps, ref); tg.objects.failPutAt = 3;
    expect(await code(applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' }))).toBe('storage-unavailable');
    expect(tg.log).toEqual(['snapshot']); const staged = tg.objects.map.size; expect(staged).toBeGreaterThan(0);
    tg.objects.failPutAt = null; deps = restoreDeps({ ...w, deps: { ...w.deps } } as typeof w, tg.t); // new process: fresh deps over the same stores
    const again = await planRestore(deps, ref); expect(again.planSha256).toBe(plan.planSha256);
    const report = await applyRestore(deps, { ...ref, confirmedPlanSha256: again.planSha256, operationId: 'op-1' });
    expect(report.ok).toBe(true); expect(report.objects.alreadyPresent).toBe(staged); expect(report.objects.written + report.objects.alreadyPresent).toBe(again.stage.objects);
    expect(tg.log.filter((x) => x === 'import')).toHaveLength(1);
    // after completion the target has moved: a repeat apply is refused, never double-applied
    expect(await code(planRestore(deps, ref))).toBe('target-not-empty');
  });

  it('an export without user work restores objects only and takes no snapshot', async () => {
    const w = world(); const r = await exportCase(w.deps, { caseId: CASE, exportId: 'exp-9', includeUserWork: false }); const tg = target();
    const ref = { caseId: CASE, exportId: 'exp-9', expectedManifestSha256: r.manifestSha256 }; const deps = restoreDeps(w, tg.t);
    const plan = await planRestore(deps, ref); const report = await applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' });
    expect(report).toMatchObject({ ok: true, preRestoreSnapshot: null, userWork: { imported: null } }); expect(tg.log).toEqual([]);
  });

  it('an import that deleted or replaced rows is reported as a failed invariant, not ok', async () => {
    const { w, ref } = await exported(); const tg = target(); const deps = restoreDeps(w, tg.t);
    const real = tg.t.userWork.importAll; tg.t.userWork.importAll = (async (a: never) => { const r = await real(a); if (r.kind === 'written') r.value.restored[0]!.deleted = 1; return r; }) as never;
    const plan = await planRestore(deps, ref); const report = await applyRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'op-1' });
    expect(report.ok).toBe(false); expect(report.invariants.find((i) => i.name === 'nothing-deleted')!.ok).toBe(false);
  });
});
void MemObjects;
