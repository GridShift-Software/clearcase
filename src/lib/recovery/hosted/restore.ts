import type { AsyncUserWork, CaseId, CaseRevision, ClientId, UserWorkExport } from '../../server/runtime/contracts.ts';
import { recordAfter, recordFailure } from './authority.ts';
import { canonicalJson, encode, fail, ID, SHA, sha256Hex } from './bytes.ts';
import { exportScopes, loadExport, type VerifyRequest, type Verified } from './verify.ts';
import type { Accounting, CommitBoundary, PrivateObjectPort, ReadBoundary, RecoveryDeps, RecoveryUserWork } from './types.ts';
import { recheckExportAuthority } from './visibility.ts';
import { loadNativeExport, recheckNative } from './native-evidence.ts';

/** An isolated restore target: a scope that is not the live client instance. Nothing in it is ever the live case's data. */
export interface RestoreTarget {
  readonly isolationId: string; readonly clientId: ClientId; readonly caseId: CaseId;
  readonly objects: PrivateObjectPort;
  readonly userWork: RecoveryUserWork & {
    importAll(a: Parameters<AsyncUserWork['importAll']>[0] & CommitBoundary): ReturnType<AsyncUserWork['importAll']>;
    snapshots: {
      put(a: Parameters<AsyncUserWork['snapshots']['put']>[0] & CommitBoundary): ReturnType<AsyncUserWork['snapshots']['put']>;
      get(a: Parameters<AsyncUserWork['snapshots']['get']>[0] & ReadBoundary): ReturnType<AsyncUserWork['snapshots']['get']>;
    };
  };
  stateRevision(boundary?: ReadBoundary): Promise<CaseRevision>;
  /** Native receiving authority, after the controller's final source check. Not a combined principal. */
  checkAuthority?(): Promise<void>;
}
export interface RestoreDeps extends RecoveryDeps { liveIsolationId: string; target: RestoreTarget | null }
export interface RestorePlan {
  planSha256: string; manifestSha256: string; exportId: string; source: { clientId: ClientId; caseId: CaseId };
  target: { isolationId: string; clientId: ClientId; caseId: CaseId; revision: CaseRevision };
  categories: Pick<Accounting, 'originals' | 'previews' | 'resultsPackages' | 'userWork'>;
  stage: { objects: number; bytes: number }; destructive: false; deletes: 0;
}
export interface RestoreRequest extends VerifyRequest { }
export interface ApplyRequest extends RestoreRequest { confirmedPlanSha256: string; operationId: string }
export interface RestoreReport {
  ok: boolean; planSha256: string; preRestoreSnapshot: string | null;
  objects: { planned: number; written: number; alreadyPresent: number; verified: number };
  userWork: { planned: { tables: number; rows: number }; imported: { tables: number; rows: number; deleted: number; replaced: number } | null };
  invariants: { name: string; ok: boolean }[]; activated: false;
}

const prefixOf = (t: RestoreTarget, exportId: string) => `restore/${t.clientId}/${t.caseId}/${exportId}`;
const writeScope = (caseId: CaseId) => [...exportScopes(caseId), { caseId, operation: 'write-user-work' as const }];

function requireTarget(deps: RestoreDeps): RestoreTarget {
  const t = deps.target;
  if (!t || !deps.objects) throw fail('recovery-unavailable', true);
  if (t.clientId !== deps.identity.clientId) throw fail('foreign-input');
  if (!ID.test(t.isolationId) || t.isolationId === deps.liveIsolationId || t.objects === deps.objects || t.userWork === (deps.userWork as unknown)) throw fail('target-not-isolated');
  if (deps.profile === 'production' && t.objects.kind !== 'durable-private') throw fail('recovery-unavailable', true);
  return t;
}
async function emptyUserWork(t: RestoreTarget, beforeRead?: () => Promise<void>) {
  await beforeRead?.();
  const snap = await t.userWork.exportAll({ caseId: t.caseId, beforeRead });
  if (snap.tables.some((x) => x.rows.length > 0)) throw fail('target-not-empty');
  return snap;
}
function buildPlan(v: Verified & { caseId: CaseId; sealedManifest?: Uint8Array }, t: RestoreTarget, revision: CaseRevision, req: RestoreRequest): Omit<RestorePlan, 'planSha256'> {
  const { accounting: a } = v;
  return {
    manifestSha256: v.manifestSha256, exportId: req.exportId, source: { clientId: v.manifest.clientId, caseId: v.caseId },
    target: { isolationId: t.isolationId, clientId: t.clientId, caseId: t.caseId, revision },
    categories: { originals: a.originals, previews: a.previews, resultsPackages: a.resultsPackages, userWork: a.userWork },
    stage: { objects: v.blobs.size + 1, bytes: [...v.blobs.values()].reduce((n, b) => n + b.length, 0) + (v.sealedManifest?.length ?? 0) }, destructive: false, deletes: 0,
  };
}
async function plan(deps: RestoreDeps, req: RestoreRequest, action: string, scopes: typeof writeScope, native = false) {
  const t = requireTarget(deps); // required-null and isolation refuse before authority, reads or any byte
  const nv = native ? await loadNativeExport(deps, req, scopes, action) : null;
  const v = nv ?? await loadExport(deps, req, scopes, action);
  const recheck = (s: Parameters<typeof recheckExportAuthority>[2]) => nv ? recheckNative(deps, nv.nativeManifest, s) : recheckExportAuthority(deps, v.manifest, s);
  try {
    const beforeRead = () => recheck(scopes(v.caseId));
    await beforeRead();
    const revision = await t.stateRevision({ beforeRead });
    if (v.manifest.userWork) await emptyUserWork(t, beforeRead);
    const p = buildPlan(v, t, revision, req);
    // A staged object that differs from the export is a conflict now, before any apply: nothing is overwritten.
    const prefix = prefixOf(t, req.exportId);
    for (const [sha, bytes] of v.blobs) await conflict(t.objects, `${prefix}/blobs/${sha}`, bytes, beforeRead);
    if ('sealedManifest' in v && v.sealedManifest instanceof Uint8Array) await conflict(t.objects, `${prefix}/manifest.json`, v.sealedManifest, beforeRead);
    return { v, t, revision, recheck, plan: { ...p, planSha256: await sha256Hex(encode(canonicalJson(p))) } as RestorePlan };
  } catch (e) { await recordFailure(deps, { action, objectKind: 'case-export', objectId: req.exportId, caseId: v.caseId }, e); throw e; }
}
async function conflict(o: PrivateObjectPort, key: string, bytes: Uint8Array, beforeRead?: () => Promise<void>) {
  await beforeRead?.();
  const have = await o.get(key, { beforeRead }).catch(() => { throw fail('storage-unavailable', true); });
  if (have && (have.length !== bytes.length || await sha256Hex(have) !== await sha256Hex(bytes))) throw fail('restore-conflict');
}

/** Read-only: verifies the export, the target's isolation, emptiness and revision, and returns the plan to confirm. Writes nothing. */
export const planRestore = (deps: RestoreDeps, req: RestoreRequest): Promise<RestorePlan> => planRestoreUsing(deps, req, false);
export const planNativeRestore = (deps: RestoreDeps, req: RestoreRequest): Promise<RestorePlan> => planRestoreUsing(deps, req, true);
async function planRestoreUsing(deps: RestoreDeps, req: RestoreRequest, native: boolean): Promise<RestorePlan> {
  const { plan: p, v, t, recheck } = await plan(deps, req, 'recovery.restore.plan', exportScopes, native);
  const audit = { action: 'recovery.restore.plan', objectKind: 'case-export', objectId: req.exportId, caseId: v.caseId };
  try {
    await recordAfter(deps, { ...audit, outcome: 'succeeded' });
    await recheck(exportScopes(v.caseId));
    await t.checkAuthority?.();
    return p;
  } catch (e) { await recordFailure(deps, audit, e); throw e; }
}

/**
 * Stages the export into the isolated target and imports its user work behind the expected-revision guard, after taking the
 * target's pre-restore snapshot. Only an explicit confirmation of the exact current plan applies; staged objects are additive
 * (existing identical objects are kept, differing ones refuse before any write); nothing is deleted, nothing is activated.
 */
export const applyRestore = (deps: RestoreDeps, req: ApplyRequest): Promise<RestoreReport> => applyRestoreUsing(deps, req, false);
export const applyNativeRestore = (deps: RestoreDeps, req: ApplyRequest): Promise<RestoreReport> => applyRestoreUsing(deps, req, true);
async function applyRestoreUsing(deps: RestoreDeps, req: ApplyRequest, native: boolean): Promise<RestoreReport> {
  if (!SHA.test(req.confirmedPlanSha256) || !ID.test(req.operationId)) throw fail('invalid-request');
  const { plan: p, v, t, revision, recheck } = await plan(deps, req, 'recovery.restore.apply', writeScope, native);
  const audit = { action: 'recovery.restore.apply', objectKind: 'case-export', objectId: req.exportId, caseId: v.caseId };
  try {
    if (p.planSha256 !== req.confirmedPlanSha256) throw fail('plan-mismatch');
    const beforeIO = () => recheck(writeScope(v.caseId));
    await beforeIO();
    if ((await t.stateRevision({ beforeRead: beforeIO })) !== revision) throw fail('stale-state');
    const prefix = prefixOf(t, req.exportId);
    const invariants: RestoreReport['invariants'] = [];
    let snapshotId: string | null = null; let imported: RestoreReport['userWork']['imported'] = null;
    const uw = v.manifest.userWork;
    let snapshot: UserWorkExport | null = null;
    if (uw) {
      try { snapshot = JSON.parse(new TextDecoder().decode(v.blobs.get(uw.sha256)!)) as UserWorkExport; } catch { throw fail('manifest-invalid'); }
      if (snapshot.format !== 'clearcase.user-work/1' || !Array.isArray(snapshot.tables)) throw fail('manifest-invalid');
    }
    const seal: [string, Uint8Array] = [`${prefix}/manifest.json`, 'sealedManifest' in v && v.sealedManifest instanceof Uint8Array ? v.sealedManifest : encode(canonicalJson(v.manifest))];
    const blobItems = [...v.blobs].map(([sha, b]) => [`${prefix}/blobs/${sha}`, b] as [string, Uint8Array]);
    const items: [string, Uint8Array][] = native ? [...blobItems, seal] : [seal, ...blobItems];
    await conflict(t.objects, seal[0], seal[1], beforeIO);
    const objects = { planned: items.length, written: 0, alreadyPresent: 0, verified: 0 };
    // Pre-restore snapshot of the target's own work, before the first change to it.
    await beforeIO();
    if (snapshot) {
      const empty = await emptyUserWork(t, beforeIO);
      await beforeIO();
      snapshotId = await t.userWork.snapshots.put({ caseId: t.caseId, snapshot: empty, revision, beforeCommit: beforeIO });
    }
    for (const [key, bytes] of items) {
      const sha256 = await sha256Hex(bytes);
      await recheck(writeScope(v.caseId));
      const r = await t.objects.putIfAbsent({ key, bytes, sha256, beforeCommit: () => recheck(writeScope(v.caseId)) }).catch(() => { throw fail('storage-unavailable', true); });
      if (r.kind === 'created') objects.written += 1; else objects.alreadyPresent += 1;
    }
    for (const [key, bytes] of items) {
      await beforeIO();
      const back = await t.objects.get(key, { beforeRead: beforeIO }).catch(() => { throw fail('storage-unavailable', true); });
      if (back && back.length === bytes.length && await sha256Hex(back) === await sha256Hex(bytes)) objects.verified += 1;
    }
    invariants.push({ name: 'objects-accounted', ok: objects.written + objects.alreadyPresent === objects.planned }, { name: 'objects-verified', ok: objects.verified === objects.planned });
    // Integrity is a precondition, not merely a post-import warning. Keep the snapshot/additive objects for inspection.
    if (objects.verified !== objects.planned || objects.written + objects.alreadyPresent !== objects.planned) throw fail('restore-failed');
    if (snapshot && !snapshotId) throw fail('restore-failed');
    if (snapshot && snapshotId) {
      await recheck(writeScope(v.caseId));
      // The expected-revision guard also prevents importing into a target that moved since the plan.
      const r = await t.userWork.importAll({ caseId: t.caseId, expectedRevision: revision, operationId: req.operationId, snapshot, preRestore: snapshotId as never, beforeCommit: beforeIO });
      if (r.kind === 'stale') throw fail('stale-state');
      if (r.kind === 'gone') throw fail('not-found');
      const deleted = r.value.restored.reduce((n, x) => n + x.deleted, 0), replaced = r.value.restored.reduce((n, x) => n + (x.replaced ?? 0), 0);
      imported = { tables: r.value.tables, rows: r.value.rows, deleted, replaced };
      invariants.push({ name: 'user-work-rows-accounted', ok: r.value.rows === uw!.rows && r.value.tables === uw!.tables }, { name: 'nothing-deleted', ok: deleted === 0 && replaced === 0 });
    }
    if (native && !invariants.every((i) => i.ok)) throw fail('restore-failed');
    await recordAfter(deps, { ...audit, outcome: invariants.every((i) => i.ok) ? 'succeeded' : 'failed' });
    await recheck(writeScope(v.caseId));
    await t.checkAuthority?.();
    return { ok: invariants.every((i) => i.ok), planSha256: p.planSha256, preRestoreSnapshot: snapshotId, objects, userWork: { planned: { tables: uw?.tables ?? 0, rows: uw?.rows ?? 0 }, imported }, invariants, activated: false };
  } catch (e) { await recordFailure(deps, audit, e); throw e; }
}
