import { expect, it } from 'vitest';
import { applyRestore, exportCase, planRestore, verifyExport } from '../../../src/lib/recovery/hosted/index.ts';
import { CASE, enc, restoreDeps, target, world } from './world.ts';

async function exported() {
  const w = world();
  const r = await exportCase(w.deps, { caseId: CASE, exportId: 'probe-export', includeUserWork: true });
  const ref = { caseId: CASE, exportId: 'probe-export', expectedManifestSha256: r.manifestSha256 };
  return { w, r, ref };
}
const outcome = <T>(p: Promise<T>) => p.then(value => ({kind: 'resolved' as const, value}), (e: {code?: string}) => ({kind:'refused' as const, code:e.code}));

it('P1: retained results cannot be exposed or restored after withdrawal under an otherwise current case grant', async () => {
  const {w, ref} = await exported();
  const tg = target(); const deps = restoreDeps(w, tg.t);
  // Confirm before withdrawal too: a retained plan must not become a bypass.
  const priorPlan = await planRestore(deps, ref);
  w.deps.store.getCase = async () => ({caseId:CASE, caseLabel:'Synthetic', publication:{kind:'withdrawn'}, href:'/c', documents:null});
  w.deps.store.activeVersionId = async () => null;
  w.deps.store.versionsOf = async () => [];
  const verify = await outcome(verifyExport(w.deps, ref));
  const plan = await outcome(planRestore(deps, ref));
  const restored = await outcome(applyRestore(deps, {...ref, confirmedPlanSha256:priorPlan.planSha256, operationId:'probe-withdrawn'}));
  const protectedFile = [...tg.objects.map.values()].some(b => new TextDecoder().decode(b) === '[1,2,3]');
  console.log('P1 observed', JSON.stringify({verify:verify.kind, previews:verify.kind === 'resolved' ? verify.value.manifest.previews.length : 0, restored:restored.kind, protectedFile}));
  expect(verify.kind).toBe('refused');
  expect(protectedFile).toBe(false);
  expect(plan).toMatchObject({kind:'refused', code:'not-found'});
  expect(restored).toMatchObject({kind:'refused', code:'not-found'});
  expect(tg.log).toEqual([]);
});

it('P2: revocation during stored-export verification must be checked again before returning protected manifest', async () => {
  const {w, ref} = await exported();
  const get = w.objects.get.bind(w.objects);
  let reads = 0;
  w.objects.get = async key => { const b = await get(key); if (++reads === 2) w.k.revoked = true; return b; };
  const checksBefore = w.calls.checkRevocation;
  const verified = await outcome(verifyExport(w.deps, ref));
  console.log('P2 observed', JSON.stringify({outcome:verified.kind, revoked:w.k.revoked, checksDuring:w.calls.checkRevocation-checksBefore, reads}));
  expect(verified.kind).toBe('refused');
});

it('P3: failed staged-object integrity must refuse before importing user work', async () => {
  const {w, ref} = await exported(); const tg=target(); const deps=restoreDeps(w,tg.t);
  const plan=await planRestore(deps,ref);
  const put=tg.objects.putIfAbsent.bind(tg.objects);
  tg.objects.putIfAbsent=async a => put({...a,bytes:a.key.includes('/blobs/') ? enc('corrupt staged bytes') : a.bytes});
  const result=await outcome(applyRestore(deps,{...ref,confirmedPlanSha256:plan.planSha256,operationId:'probe-corrupt-target'}));
  console.log('P3 observed', JSON.stringify({outcome:result.kind,reportOk:result.kind === 'resolved' ? result.value.ok : null, imports:tg.imports.length, log:tg.log}));
  expect(tg.imports).toHaveLength(0);
  expect(result).toMatchObject({kind:'refused', code:'restore-failed'});
  expect(tg.log).toEqual(['snapshot']);
  expect(tg.snaps.size).toBe(1);
  expect(tg.objects.map.size).toBe(plan.stage.objects);
});
