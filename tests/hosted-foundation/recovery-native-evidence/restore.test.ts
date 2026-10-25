// Additive sealed /2 staging through actual D1 user-work APIs; no provider/runtime acceptance.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { planNativeRestore, applyNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { world, CASE, CLIENT, type World } from '../recovery-native-adapters/world.ts';
import { nativeWorld, req } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function pair() {
  const source = await nativeWorld(true), target = await world(true, true, true); worlds.push(source, target);
  source.options.target = target.options;
  const note = await source.work().addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'native-source-note', target: { kind: 'case' }, body: 'Preserved native evidence note' });
  expect(note.kind).toBe('written');
  const deps = await source.deps(), out = await exportNativeCase(deps, req), ref = { ...req, expectedManifestSha256: out.manifestSha256 };
  return { source, target, deps, out, ref };
}
it('stages the exact sealed /2 archive and work into a separate target without activating any native data or grants', async () => {
  const { source, target, deps, out, ref } = await pair();
  const grantsBefore = target.db.rows('SELECT * FROM tenant_case_grants'), plan = await planNativeRestore(deps, ref);
  expect(target.bucket.puts).toEqual([]);
  await expect(applyNativeRestore(deps, { ...ref, confirmedPlanSha256: 'a'.repeat(64), operationId: 'wrong-native-plan' })).rejects.toMatchObject({ code: 'plan-mismatch' });
  const result = await applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'native-restore' });
  expect(result).toMatchObject({ ok: true, activated: false, userWork: { imported: { rows: 1, deleted: 0, replaced: 0 } } });
  const prefix = `restore/${CLIENT}/${CASE}/${req.exportId}`;
  const manifest = await deps.target!.objects.get(`${prefix}/manifest.json`);
  expect(manifest).toEqual(await deps.objects!.get(out.manifestKey));
  expect(JSON.parse(new TextDecoder().decode(manifest!)).format).toBe('clearcase.recovery-export/2');
  for (const r of out.manifest.references) expect(await deps.target!.objects.get(`${prefix}/${r.blob}`)).toEqual(await deps.objects!.get(out.manifestKey.replace('manifest.json', r.blob)));
  expect(target.db.rows('SELECT body FROM uw_note')).toEqual([{ body: 'Preserved native evidence note' }]);
  expect(target.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(1);
  for (const table of ['rs_results_version', 'rs_publication', 'native_candidate', 'native_import_link', 'native_candidate_audit_intent', 'submissions_revision', 'rs_case_original']) expect(target.db.rows(`SELECT * FROM ${table}`)).toEqual([]);
  expect(target.db.rows('SELECT * FROM tenant_case_grants')).toEqual(grantsBefore);
  expect(source.db.rows('SELECT * FROM native_candidate')).toHaveLength(2);
});
it('refuses missing referenced bytes at restore planning, before any target mutation', async () => {
  const { source, target, deps, out, ref } = await pair();
  source.bucket.objects.delete(out.manifestKey.replace('manifest.json', out.manifest.references[0]!.blob));
  await expect(planNativeRestore(deps, ref)).rejects.toMatchObject({ code: 'export-incomplete' });
  expect(target.bucket.puts).toEqual([]); expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
});
it('refuses corrupted staging before importing work and does not retry an uncertain import as success', async () => {
  const { target, deps, ref } = await pair(), plan = await planNativeRestore(deps, ref);
  target.bucket.alter = (key, o) => key.includes('/blobs/') ? { ...o, size: o.size + 1 } : o;
  await expect(applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'corrupt-native-target' })).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(target.db.rows('SELECT * FROM uw_note')).toEqual([]);
  expect(target.db.rows('SELECT * FROM uw_operation')).toEqual([]);
});
it('preserves a competing target writer through the real expected-revision guard', async () => {
  const { target, deps, ref } = await pair(), plan = await planNativeRestore(deps, ref);
  target.bucket.beforePut = async () => {
    await target.work().addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'concurrent-native-note', target: { kind: 'case' }, body: 'Competing work survives' });
  };
  await expect(applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'native-stale' })).rejects.toMatchObject({ code: 'stale-state' });
  expect(target.db.rows('SELECT body FROM uw_note')).toEqual([{ body: 'Competing work survives' }]);
  expect(target.db.rows('SELECT * FROM rs_publication')).toEqual([]);
});
it('rechecks source and separately authenticated receiving authority', async () => {
  const { target, deps, ref } = await pair(), plan = await planNativeRestore(deps, ref);
  target.state.revoked = true;
  await expect(applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'revoked-native-target' })).rejects.toMatchObject({ code: 'invalid-session' });
  expect(target.bucket.puts).toEqual([]); expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
});
