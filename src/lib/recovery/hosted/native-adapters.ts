// Native bindings only; no routes, provisioning, credentials, publication or grant writers.
import type { AuditSink, CaseId, ClientId, Identity, OriginalEntry, ResultsVersion, VersionInfo } from '../../server/runtime/contracts.ts';
import { codeOf, contractError, isDenial } from '../../server/runtime/errors.ts';
import type { CloudD1, CloudR2, CloudR2Body } from '../../storage/cloud/bindings.ts';
import { storageGate } from '../../storage/cloud/gate.ts';
import { storageBudgets, type StorageBudgets } from '../../storage/cloud/budgets.ts';
import { writeOnce } from '../../storage/cloud/objects.ts';
import { createCloudResults } from '../../results/hosted/index.ts';
import { requirePublished } from '../../results/hosted/versions.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig, type D1UserWorkConfig } from '../../user-work/hosted/d1-user-work.ts';
import { resolveExactDeployment, validateClientManifest, type ClientResourceIdentity, type ExactDeploymentTuple } from '../../tenancy/manifest.ts';
import { ID, SHA, sha256Hex } from './bytes.ts';
import type { Limits, PreviewCatalog, PrivateObjectPort, RecoveryDeps, VersionVisibilityPort } from './types.ts';
import type { RestoreDeps, RestoreTarget } from './restore.ts';

/** R2's native streaming body is required: arrayBuffer() alone cannot enforce a read bound. */
export interface RecoveryR2 extends CloudR2 {
  get(key: string): Promise<(CloudR2Body & { body: ReadableStream<Uint8Array> }) | null>;
}
export interface RecoveryD1 extends CloudD1 { withSession(constraint: 'first-primary'): CloudD1 }
/** Both identities come from the trusted native binder, NEVER a route/body/hostname or a caller-supplied label.
 * boundResources must describe the handles actually bound by deployment, not a second copy of requested settings.
 * The platform does not expose these resource ids through prepare/get: their association is a parent responsibility.
 */
export interface NativeRecoveryResources {
  deployment: ClientResourceIdentity;
  boundResources: ExactDeploymentTuple;
  db: RecoveryD1;
  bucket: RecoveryR2;
}
export interface NativeRecoveryLimits extends Limits { maxManifestBytes: number }
export interface NativeRecoverySource {
  resources: NativeRecoveryResources;
  /** The genuine request identity and sink, as authenticated in this receiving deployment. */
  identity: Identity;
  audit: AuditSink;
  storageBudgets: StorageBudgets;
  userWork: D1UserWorkConfig;
}
export interface NativeRecoveryOptions extends NativeRecoverySource {
  caseId: CaseId;
  limits: NativeRecoveryLimits;
  now(): Date;
  newId(): string;
  /** Separately provisioned and authenticated deployment. Absence/unprovisioned resources stay null (503 on restore). */
  target: NativeRecoverySource | null;
}

const unavailable = (): never => { throw contractError('recovery-unavailable', true); };
const corrupt = (): never => { throw contractError('export-corrupt'); };
const resourceKeys = ['hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const;
const RV = /^sha256:[0-9a-f]{64}$/;
function limitsOf(value: NativeRecoveryLimits): Readonly<NativeRecoveryLimits> {
  if (!value || Object.keys(value).sort().join() !== 'maxFileBytes,maxFiles,maxManifestBytes,maxTotalBytes' ||
    !Object.values(value).every((n) => Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) || value.maxFileBytes > value.maxTotalBytes) unavailable();
  return Object.freeze({ ...value });
}
function resourcesOf(r: NativeRecoveryResources): ClientResourceIdentity {
  if (!r || typeof r.db?.withSession !== 'function' || typeof r.bucket?.get !== 'function' || typeof r.bucket?.head !== 'function' || typeof r.bucket?.put !== 'function') return unavailable();
  try {
    const { staffIssuer, ...client } = r.deployment;
    return resolveExactDeployment(validateClientManifest({ staffIssuer, clients: [client] }), r.boundResources);
  } catch { return unavailable(); }
}
function caller(identity: Identity, clientId: ClientId) {
  if (!identity || identity.clientId !== clientId || identity.kind !== 'verified' || !identity.principal || !identity.sessionId) throw contractError('unauthenticated');
}
async function authority(identity: Identity, clientId: ClientId, caseId: CaseId, write = false) {
  caller(identity, clientId);
  await identity.checkRevocation();
  for (const operation of ['read', 'read-original', 'read-preview', ...(write ? ['write-user-work' as const] : [])] as const) await identity.authorize({ caseId, operation });
  await identity.checkRevocation();
}
const sameActor = (a: Identity, b: Identity) => a.kind === 'verified' && b.kind === 'verified' && a.clientId === b.clientId &&
  a.principal.issuer === b.principal.issuer && a.principal.subject === b.principal.subject && a.principal.kind === b.principal.kind;
const checksum = (value: ArrayBuffer | undefined): string | null => value?.byteLength === 32 ? [...new Uint8Array(value)].map((n) => n.toString(16).padStart(2, '0')).join('') : null;

/** One case and namespace only. Every delivery is private, fully buffered within an explicit bound, and verified.
 * No URL, stream, unchecked range, overwrite or delete capability escapes this adapter.
 */
function privateObjects(a: { db: CloudD1; bucket: RecoveryR2; clientId: ClientId; caseId: CaseId; namespace: 'export' | 'restore'; limits: NativeRecoveryLimits; check(): Promise<void> }): PrivateObjectPort {
  const gate = storageGate({ db: a.db, bucket: a.bucket }, a.clientId);
  const prefix = a.namespace === 'export' ? `recovery/exports/${a.clientId}/${a.caseId}/` : `restore/${a.clientId}/${a.caseId}/`;
  function scoped(key: string) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) throw contractError('foreign-input');
    const tail = key.slice(prefix.length).split('/');
    if (!ID.test(tail[0] ?? '') || tail[0] === '.' || tail[0] === '..') throw contractError('foreign-input');
    if (tail.length === 2 && tail[1] === 'manifest.json') return { max: a.limits.maxManifestBytes, sha: null };
    if (tail.length === 3 && tail[1] === 'blobs' && SHA.test(tail[2]!)) return { max: a.limits.maxFileBytes, sha: tail[2]! };
    throw contractError('foreign-input');
  }
  async function guard() { if (await gate()) unavailable(); await a.check(); }
  async function get(key: string): Promise<Uint8Array | null> {
    const scope = scoped(key);
    await guard();
    const object = await a.bucket.get(key).catch(unavailable);
    if (!object) { await a.check(); return null; }
    const expected = checksum(object.checksums?.sha256);
    // Do not touch a body with invalid metadata. R2 creates the body lazily; cancel on all refusals.
    if (object.key !== key || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > scope.max || !expected || (scope.sha !== null && scope.sha !== expected) || typeof object.body?.getReader !== 'function') {
      await object.body?.cancel().catch(() => undefined);
      if (object.size > scope.max) throw contractError('export-too-large');
      return corrupt();
    }
    const reader = object.body.getReader();
    let length = 0, chunks = 0;
    try {
      const bytes = new Uint8Array(object.size);
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (++chunks > object.size + 1 || !(next.value instanceof Uint8Array) || next.value.length > bytes.length - length) return corrupt();
        bytes.set(next.value, length); length += next.value.length;
      }
      if (length !== bytes.length || await sha256Hex(bytes) !== expected) return corrupt();
      await a.check();
      return bytes;
    } catch (e) {
      if (codeOf(e)) throw e;
      return unavailable();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  return Object.freeze<PrivateObjectPort>({
    kind: 'durable-private', get,
    async putIfAbsent({ key, bytes: input, sha256 }) {
      const scope = scoped(key);
      if (!(input instanceof Uint8Array) || input.length > scope.max) throw contractError('export-too-large');
      if (!SHA.test(sha256) || (scope.sha !== null && scope.sha !== sha256)) return corrupt();
      // Own the bytes before any await; a caller cannot race a checksum with a mutation of its buffer.
      const bytes = new Uint8Array(input);
      if (await sha256Hex(bytes) !== sha256) return corrupt();
      await guard();
      const result = await writeOnce(a.bucket, key, bytes, sha256);
      if (result === 'conflict') return corrupt();
      // Includes a conditional race or an acknowledgement lost AFTER commit. Never infer success from an ETag/head.
      const back = await get(key);
      if (!back) return unavailable();
      if (back.length !== bytes.length || await sha256Hex(back) !== sha256) return corrupt();
      return { kind: result === 'written' ? 'created' : 'exists' };
    },
  });
}

function currentVisibility(a: { db: CloudD1; identity: Identity; clientId: ClientId; caseId: CaseId; gate(): Promise<unknown> }): VersionVisibilityPort {
  return Object.freeze<VersionVisibilityPort>({
    kind: 'current-policy',
    async isVisible(q) {
      // Only this authenticated receiving-request service can ask; a structurally forged Identity carries no authority.
      if (q.identity !== a.identity || q.caseId !== a.caseId || !RV.test(q.resultsVersion) || q.identity.clientId !== a.clientId || q.identity.kind !== 'verified') return false;
      try {
        if (await a.gate()) return unavailable();
        for (let pass = 0; pass < 2; pass++) {
          await authority(a.identity, a.clientId, a.caseId);
          // Exact current publication + stored/case identity + withdrawal, on the SAME primary session as the catalogue.
          await requirePublished(a.db, a.caseId, q.resultsVersion);
        }
        return true;
      } catch (e) { if (isDenial(e) || codeOf(e) === 'not-found') return false; return unavailable(); }
    },
  });
}

/** Builds the real source reader/assets/user-work on a single first-primary session; no request-time DDL. */
async function openSource(a: NativeRecoverySource, now: () => Date) {
  const deployment = resourcesOf(a.resources), clientId = deployment.clientId;
  if (!a.identity || a.identity.clientId !== clientId || typeof a.identity.checkRevocation !== 'function' || typeof a.identity.authorize !== 'function' || !a.audit || typeof a.audit.append !== 'function') return unavailable();
  const budgets = storageBudgets(a.storageBudgets);
  if (!budgets) return unavailable();
  let config: D1UserWorkConfig;
  try { config = userWorkConfig(a.userWork); } catch { return unavailable(); }
  if (config.clientId !== clientId) return unavailable();
  let db: CloudD1;
  try { db = a.resources.db.withSession('first-primary'); } catch { return unavailable(); }
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') return unavailable();
  const bucket = a.resources.bucket;
  const gate = storageGate({ db, bucket }, clientId);
  if (await gate()) return unavailable();
  const binding = await db.prepare('SELECT client_id, schema_version FROM uw_binding WHERE singleton = 1').first<{ client_id: string; schema_version: number }>().catch(unavailable);
  if (binding?.client_id !== clientId || binding.schema_version !== 1) return unavailable();
  const revision = d1WorkRevision({ db, config });
  const { store, assets } = createCloudResults({ bindings: { db, bucket }, clientId, budgets, identity: a.identity, stateRevision: revision, now,
    record: async (event) => {
      const identity = a.identity;
      const actor = identity.kind === 'verified' ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous' as const, principal: null, sessionId: null };
      await a.audit.append({ ...event, eventId: crypto.randomUUID(), actor, at: now().toISOString() });
    },
  });
  const userWork = createD1UserWork({ db, config, identity: a.identity, audit: a.audit, store, now, tableDefinitions: null });
  return { deployment, clientId, db, bucket, gate, store, assets, userWork, revision, budgets, config };
}

/** Factory for the existing /1 archive and NON-ACTIVATING restore contracts. Throws 503 for unusable source config.
 * Native import/submission lineage is not representable in /1: source export explicitly holds instead of losing it.
 * Low-level current visibility, preview enumeration and private object IO remain useful independently of that hold.
 */
export async function createNativeRecoveryAdapters(input: NativeRecoveryOptions): Promise<RestoreDeps> {
  // Capture request/binding handles before any await. Reusing a mutable configuration object for another request
  // must not switch an already-built port's caller, case or target authority.
  const a: NativeRecoveryOptions = { ...input, resources: { ...input.resources }, target: input.target ? { ...input.target, resources: { ...input.target.resources } } : null };
  const limits = limitsOf(a.limits);
  if (!ID.test(a.caseId) || typeof a.now !== 'function' || typeof a.newId !== 'function') return unavailable();
  const s = await openSource(a, a.now), { clientId, db } = s;
  // Source readers buffer whole files; these upstream bounds must not bypass the recovery's smaller explicit policy.
  if (s.budgets.maxBufferedObjectBytes > limits.maxFileBytes || s.budgets.maxPackageFileBytes > limits.maxFileBytes || s.config.limits.maxSnapshotBytes > limits.maxFileBytes) return unavailable();
  const check = () => authority(a.identity, clientId, a.caseId);
  const visibility = currentVisibility({ ...s, identity: a.identity, caseId: a.caseId });
  async function visible(resultsVersion: ResultsVersion) {
    if (await visibility.isVisible({ identity: a.identity, caseId: a.caseId, resultsVersion }) !== true) throw contractError('not-found');
  }
  function scope(caseId: CaseId) { if (caseId !== a.caseId) throw contractError('foreign-input'); }
  const previews = Object.freeze<PreviewCatalog>({
    async previewsOf(q) {
      scope(q.caseId); await visible(q.resultsVersion);
      const { results } = await db.prepare(`SELECT p.asset_id, p.filename, p.media_type, p.size FROM rs_preview p
        JOIN rs_results_version v ON v.version_id = p.version_id AND v.case_id = ? AND v.state = 'stored'
        WHERE p.version_id = ? ORDER BY p.asset_id LIMIT ?`).bind(a.caseId, q.resultsVersion, limits.maxFiles + 1)
        .all<{ asset_id: string; filename: string; media_type: string; size: number }>().catch(unavailable);
      if (results.length > limits.maxFiles || results.some((r) => !Number.isSafeInteger(r.size) || r.size < 0 || r.size > limits.maxFileBytes)) throw contractError('export-too-large');
      await visible(q.resultsVersion);
      return Object.freeze(results.map((r): OriginalEntry => Object.freeze({ assetId: r.asset_id, filename: r.filename, mediaType: r.media_type, size: r.size })));
    },
  });
  const objects = privateObjects({ ...s, caseId: a.caseId, namespace: 'export', limits, check });
  async function inventory() {
    const { results } = await db.prepare('SELECT version_id, state FROM rs_results_version WHERE case_id = ? ORDER BY import_seq LIMIT ?')
      .bind(a.caseId, limits.maxFiles + 1).all<{ version_id: ResultsVersion; state: string }>().catch(unavailable);
    if (results.length > limits.maxFiles) throw contractError('export-too-large');
    return results;
  }
  async function representable() {
    await check();
    // /1 has no slots for submission file/path -> asset bindings, import links, corrections or their audit lineage.
    // A missing schema is unavailable too: never treat an unreadable lineage as "no lineage".
    const row = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM native_candidate WHERE client_id = ? AND case_id = ?) AS candidates,
      EXISTS(SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ?) AS submissions`)
      .bind(clientId, a.caseId, clientId, a.caseId).first<{ candidates: number; submissions: number }>().catch(unavailable);
    if (!row || row.candidates !== 0 || row.submissions !== 0) return unavailable();
    // Also checked by the final getCase: a private version added during source reads must not silently disappear.
    for (const version of await inventory()) await visible(version.version_id);
  }
  const store: RecoveryDeps['store'] = {
    async getCase(q) { scope(q.caseId); await representable(); return s.store.getCase(q); },
    // Do NOT use production CaseReader.versionsOf: it deliberately returns only the current publication.
    async versionsOf(q) {
      scope(q.caseId); await representable();
      const results = await inventory();
      const versions: VersionInfo[] = [];
      for (const row of results) {
        await visible(row.version_id); // private, staging, withdrawn and superseded-invisible HOLD the entire export
        if (row.state !== 'stored') throw contractError('export-incomplete');
        const version = await s.store.getVersion({ resultsVersion: row.version_id });
        if (!version || version.case_id !== a.caseId || version.id !== row.version_id) throw contractError('foreign-input');
        versions.push(version);
      }
      await check(); return versions;
    },
    async activeVersionId(q) { scope(q.caseId); return s.store.activeVersionId(q); },
    async stateRevision(q) { scope(q.caseId); return s.store.stateRevision(q); },
    async verifyVersion(q) { scope(q.caseId); return s.store.verifyVersion(q); },
    async packageFile(q) { scope(q.caseId); return s.store.packageFile(q); },
    async packageFilePaths(q) { scope(q.caseId); return s.store.packageFilePaths(q); },
  };
  const assets: RecoveryDeps['assets'] = {
    async originals(q) {
      scope(q.caseId);
      const entries = await s.assets.originals(q);
      if (entries.length > limits.maxFiles || entries.some((x) => !Number.isSafeInteger(x.size) || x.size < 0 || x.size > limits.maxFileBytes) || entries.reduce((n, x) => n + x.size, 0) > limits.maxTotalBytes) throw contractError('export-too-large');
      await check(); return entries;
    },
    async availability(q) { scope(q.asset.caseId); return s.assets.availability(q); },
    async get(q) { scope(q.asset.caseId); return s.assets.get(q); },
  };
  const userWork: RecoveryDeps['userWork'] = { async exportAll(q) { scope(q.caseId); const snapshot = await s.userWork.exportAll(q); await check(); return snapshot; } };
  let target: RestoreTarget | null = null;
  if (a.target) {
    try {
      const t = await openSource(a.target, a.now);
      if (t.clientId !== clientId || !sameActor(a.identity, a.target.identity) || a.identity === a.target.identity ||
        resourceKeys.some((k) => t.deployment[k] === s.deployment[k]) || a.target.resources.db === a.resources.db || a.target.resources.bucket === a.resources.bucket) throw contractError('target-not-isolated');
      if (!await t.db.prepare('SELECT case_id FROM rs_case WHERE case_id = ?').bind(a.caseId).first()) return unavailable();
      const targetIdentity = a.target.identity;
      const targetCheck = async () => { await check(); await authority(targetIdentity, clientId, a.caseId, true); };
      await targetCheck();
      const targetObjects = privateObjects({ ...t, caseId: a.caseId, namespace: 'restore', limits, check: targetCheck });
      target = Object.freeze<RestoreTarget>({
        isolationId: t.deployment.worker, clientId, caseId: a.caseId, objects: targetObjects,
        async stateRevision() { await targetCheck(); const r = await t.revision({ caseId: a.caseId }); await targetCheck(); return r; },
        userWork: {
          async exportAll(q) { scope(q.caseId); await targetCheck(); const snap = await t.userWork.exportAll(q); await targetCheck(); return snap; },
          async importAll(q) { scope(q.caseId); await targetCheck(); const result = await t.userWork.importAll(q); await targetCheck(); return result; },
          snapshots: {
            async put(q) { scope(q.caseId); await targetCheck(); const id = await t.userWork.snapshots.put(q); await targetCheck(); return id; },
            async get(q) { scope(q.caseId); await targetCheck(); const snap = await t.userWork.snapshots.get(q); await targetCheck(); return snap; },
          },
        },
      });
    } catch (e) {
      if (codeOf(e) === 'target-not-isolated') throw e;
      // Unprovisioned/missing/unreachable target is never replaced with the live client or an in-memory fallback.
      target = null;
    }
  }
  return Object.freeze<RestoreDeps>({ profile: 'production', now: a.now, newId: a.newId, identity: a.identity, store, assets, previews, visibility, userWork, audit: a.audit, objects, limits, liveIsolationId: s.deployment.worker, target });
}
