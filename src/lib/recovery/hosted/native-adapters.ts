// Native bindings only; no routes, provisioning, credentials, publication or grant writers.
import type { AuditSink, CaseId, ClientId, Identity, OriginalEntry, ResultsVersion, VersionInfo } from '../../server/runtime/contracts.ts';
import { codeOf, contractError, isDenial } from '../../server/runtime/errors.ts';
import type { CloudD1, CloudD1Statement, CloudR2, CloudR2Body } from '../../storage/cloud/bindings.ts';
import { storageGate } from '../../storage/cloud/gate.ts';
import { storageBudgets, type StorageBudgets } from '../../storage/cloud/budgets.ts';
import { writeOnce } from '../../storage/cloud/objects.ts';
import { createCloudResults } from '../../results/hosted/index.ts';
import { requirePublished } from '../../results/hosted/versions.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig, type D1UserWorkConfig } from '../../user-work/hosted/d1-user-work.ts';
import { resolveExactDeployment, validateClientManifest, type ClientResourceIdentity, type ExactDeploymentTuple } from '../../tenancy/manifest.ts';
import { canonicalJson, ID, SHA, sha256Hex } from './bytes.ts';
import type { CaseAuditPort, Limits, PreviewCatalog, PrivateObjectPort, ReadBoundary, RecoveryDeps, VersionVisibilityPort } from './types.ts';
import type { RestoreDeps, RestoreTarget } from './restore.ts';
import { expectedReferences, nativeLimits, primaryEvidenceReader, type AuditScope, type NativeEvidencePort, type NativeRecoveryPolicy, type ImmutableReference } from './native-evidence.ts';

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
  /** Explicit /2 evidence policy; absent keeps native export unavailable. Legacy /1 is unchanged. */
  nativeEvidence?: NativeRecoveryPolicy | null;
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
  // All avoidable binding/controller IO precedes the final receiving authority observation.
  async function guard(beforeIO?: () => Promise<void>) { if (await gate()) unavailable(); await beforeIO?.(); await a.check(); }
  async function get(key: string, boundary?: ReadBoundary): Promise<Uint8Array | null> {
    const scope = scoped(key), beforeRead = boundary?.beforeRead;
    const checkRead = async () => { await beforeRead?.(); await a.check(); };
    await guard(beforeRead);
    const object = await a.bucket.get(key).catch(unavailable);
    if (!object) { await checkRead(); return null; }
    const expected = checksum(object.checksums?.sha256);
    // Do not touch a body with invalid metadata. R2 creates the body lazily; cancel on all refusals.
    if (object.key !== key || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > scope.max || !expected || (scope.sha !== null && scope.sha !== expected) || typeof object.body?.getReader !== 'function') {
      await object.body?.cancel().catch(() => undefined);
      if (object.size > scope.max) throw contractError('export-too-large');
      return corrupt();
    }
    const reader = object.body.getReader(), bytes = new Uint8Array(object.size);
    let length = 0, chunks = 0;
    try {
      for (;;) {
        await checkRead(); // metadata/previous pull was awaited; authorize before the next protected body read
        const next = await reader.read();
        if (next.done) break;
        if (++chunks > object.size + 1 || !(next.value instanceof Uint8Array) || next.value.length > bytes.length - length) return corrupt();
        bytes.set(next.value, length); length += next.value.length;
      }
      if (length !== bytes.length || await sha256Hex(bytes) !== expected) return corrupt();
    } catch (e) {
      if (codeOf(e)) throw e;
      return unavailable();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    await checkRead(); // cancellation is awaited too; no unchecked await follows this release observation
    return bytes;
  }
  return Object.freeze<PrivateObjectPort>({
    kind: 'durable-private', get,
    async putIfAbsent({ key, bytes: input, sha256, beforeCommit }) {
      const scope = scoped(key);
      if (!(input instanceof Uint8Array) || input.length > scope.max) throw contractError('export-too-large');
      if (!SHA.test(sha256) || (scope.sha !== null && scope.sha !== sha256)) return corrupt();
      // Own the bytes before any await; a caller cannot race a checksum with a mutation of its buffer.
      const bytes = new Uint8Array(input);
      if (await sha256Hex(bytes) !== sha256) return corrupt();
      await guard(beforeCommit);
      // writeOnce awaits head before put. Interpose at the actual write boundary, not just before preflight IO.
      let authorityError: unknown;
      const guardedBucket: CloudR2 = {
        head: a.bucket.head.bind(a.bucket), get: a.bucket.get.bind(a.bucket),
        async put(...args) {
          try { await guard(beforeCommit); } catch (e) { authorityError = e; throw e; }
          return a.bucket.put(...args);
        },
      };
      const result = await writeOnce(guardedBucket, key, bytes, sha256);
      if (authorityError) throw authorityError;
      if (result === 'conflict') return corrupt();
      // Includes a conditional race or an acknowledgement lost AFTER commit. Never infer success from an ETag/head.
      const back = await get(key, { beforeRead: beforeCommit });
      if (!back) return unavailable();
      if (back.length !== bytes.length || await sha256Hex(back) !== sha256) return corrupt();
      return { kind: result === 'written' ? 'created' : 'exists' };
    },
  });
}

/** A reference capability comes only from the completed primary batch above, never from a caller's object key. */
async function readImmutable(bucket: RecoveryR2, ref: { objectKey: string; size: number; sha256: string }, max: number, check: () => Promise<void>) {
  if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > max) throw contractError('export-too-large');
  await check();
  const object = await bucket.get(ref.objectKey).catch(unavailable);
  if (!object) throw contractError('export-incomplete');
  const reader = object.body?.getReader?.();
  if (!reader || object.key !== ref.objectKey || object.size !== ref.size || checksum(object.checksums?.sha256) !== ref.sha256 || !object.version || !object.etag) {
    await reader?.cancel().catch(() => undefined); reader?.releaseLock(); return corrupt();
  }
  let length = 0, chunks = 0;
  const bytes = new Uint8Array(ref.size);
  try {
    for (;;) {
      await check();
      const next = await reader.read(); if (next.done) break;
      if (++chunks > ref.size + 1 || !(next.value instanceof Uint8Array) || next.value.length > ref.size - length) return corrupt();
      bytes.set(next.value, length); length += next.value.length;
    }
    if (length !== ref.size || await sha256Hex(bytes) !== ref.sha256) return corrupt();
  } catch (e) { if (codeOf(e)) throw e; return unavailable(); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  await check();
  return { bytes, objectVersion: object.version, etag: object.etag };
}

/** Recovery-local composition, not a new user-work implementation or a synthetic Identity. Each call owns its
 * hook and statement association; concurrent requests cannot replace another operation's authority callback.
 * Reads observe genuine content authority; every mutation (including snapshot/import/acknowledgement) runs the
 * controller first, then receiving authorization last. Authorization/audit services use the unwrapped DB. */
function guardedD1(db: CloudD1, check: () => Promise<void>, beforeCommit?: () => Promise<void>): CloudD1 {
  const originals = new WeakMap<CloudD1Statement, CloudD1Statement>();
  const wrap = (raw: CloudD1Statement): CloudD1Statement => {
    const stmt: CloudD1Statement = {
      bind(...values) { return wrap(raw.bind(...values)); },
      async first<T>() { await check(); const r = await raw.first<T>(); await check(); return r; },
      async all<T>() { await check(); const r = await raw.all<T>(); await check(); return r; },
      async run() { await beforeCommit?.(); await check(); const r = await raw.run(); await check(); return r; },
    };
    originals.set(stmt, raw); return stmt;
  };
  return {
    prepare(sql) { return wrap(db.prepare(sql)); },
    async batch(statements) {
      const raw = statements.map((s) => { const original = originals.get(s); if (!original) return unavailable(); return original; });
      await beforeCommit?.();
      await check();
      const result = await db.batch(raw);
      await check(); return result;
    },
  };
}
function workIO(s: Awaited<ReturnType<typeof openSource>>, identity: Identity, receiving: () => Promise<void>, now: () => Date, beforeIO?: () => Promise<void>) {
  const check = async () => { await beforeIO?.(); await receiving(); };
  // User-work SELECTs contain independent target work, not source audit history. The full controller check brackets
  // the operation; genuine content authority guards every SELECT. Repeat the full hook at each actual mutation.
  const db = guardedD1(s.db, receiving, beforeIO);
  return { check, revision: d1WorkRevision({ db, config: s.config }),
    work: createD1UserWork({ db, config: s.config, identity, audit: s.userWorkAudit, store: s.store, now, tableDefinitions: null }) };
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
          // Exact live publication + stored/case identity + withdrawal on the source service session; not a snapshot.
          await requirePublished(a.db, a.caseId, q.resultsVersion);
          // The publication read itself is awaited: a session/grant revoked during it releases no metadata.
          await authority(a.identity, a.clientId, a.caseId);
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
  const revision = d1WorkRevision({ db, config }); // user-work revision only, never a whole-case/D1/R2 revision
  const { store, assets } = createCloudResults({ bindings: { db, bucket }, clientId, budgets, identity: a.identity, stateRevision: revision, now,
    record: async (event) => {
      const identity = a.identity;
      const actor = identity.kind === 'verified' ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous' as const, principal: null, sessionId: null };
      await a.audit.append({ ...event, eventId: crypto.randomUUID(), actor, at: now().toISOString() });
    },
  });
  const userWork = createD1UserWork({ db, config, identity: a.identity, audit: a.audit, store, now, tableDefinitions: null });
  return { deployment, clientId, db, bucket, gate, store, assets, userWork, userWorkAudit: a.audit, revision, budgets, config };
}

/** Factory for /1 and opt-in /2 archive and NON-ACTIVATING restore contracts. Throws 503 for unusable source config.
 * Native import/submission lineage is not representable in /1: source export explicitly holds instead of losing it.
 * Low-level current visibility, preview enumeration and private object IO remain useful independently of that hold.
 */
export async function createNativeRecoveryAdapters(input: NativeRecoveryOptions): Promise<RestoreDeps> {
  // Capture request/binding handles before any await. Reusing a mutable configuration object for another request
  // must not switch an already-built port's caller, case or target authority.
  const a: NativeRecoveryOptions = { ...input, resources: { ...input.resources }, target: input.target ? { ...input.target, resources: { ...input.target.resources } } : null };
  const limits = limitsOf(a.limits);
  const policy = a.nativeEvidence ? { ...a.nativeEvidence } : null;
  let evidenceLimits: ReturnType<typeof nativeLimits> | null = null;
  if (policy) {
    try {
      if (Object.keys(policy).some((k) => !['maxLineageRows', 'maxLineageBytes', 'visibility', 'audit'].includes(k))) return unavailable();
      if ('audit' in policy && typeof policy.audit?.caseAudit !== 'function') return unavailable();
      evidenceLimits = nativeLimits({ ...limits, maxLineageRows: policy.maxLineageRows, maxLineageBytes: policy.maxLineageBytes });
      if ('visibility' in policy && (!policy.visibility || policy.visibility.kind !== 'current-policy' || typeof policy.visibility.isVisible !== 'function')) return unavailable();
    } catch { return unavailable(); }
  }
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
    // /1 has no slots for submission file/path -> asset bindings, sets, import links, corrections or their audit lineage.
    // A missing schema is unavailable too: never treat an unreadable lineage as "no lineage".
    const row = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM native_candidate WHERE client_id = ? AND case_id = ?) AS candidates,
      EXISTS(SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ?)
        OR EXISTS(SELECT 1 FROM submissions_set WHERE client_id = ? AND case_id = ?) AS submissions`)
      .bind(clientId, a.caseId, clientId, a.caseId, clientId, a.caseId).first<{ candidates: number; submissions: number }>().catch(unavailable);
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
  const userWork: RecoveryDeps['userWork'] = { async exportAll(q) {
    scope(q.caseId); const { beforeRead, ...request } = q, io = workIO(s, a.identity, check, a.now, beforeRead);
    await io.check(); const snapshot = await io.work.exportAll(request); await io.check(); return snapshot;
  } };
  let target: RestoreTarget | null = null;
  if (a.target) {
    try {
      const t = await openSource(a.target, a.now);
      if (t.clientId !== clientId || !sameActor(a.identity, a.target.identity) || a.identity === a.target.identity ||
        resourceKeys.some((k) => t.deployment[k] === s.deployment[k]) || a.target.resources.db === a.resources.db || a.target.resources.bucket === a.resources.bucket) throw contractError('target-not-isolated');
      const targetIdentity = a.target.identity;
      const targetCheck = async () => { await check(); await authority(targetIdentity, clientId, a.caseId, true); };
      await targetCheck();
      if (!await t.db.prepare('SELECT case_id FROM rs_case WHERE case_id = ?').bind(a.caseId).first()) return unavailable();
      await targetCheck();
      const targetObjects = privateObjects({ ...t, caseId: a.caseId, namespace: 'restore', limits, check: targetCheck });
      target = Object.freeze<RestoreTarget>({
        isolationId: t.deployment.worker, clientId, caseId: a.caseId, objects: targetObjects,
        checkAuthority: targetCheck,
        async stateRevision(boundary) {
          const io = workIO(t, targetIdentity, targetCheck, a.now, boundary?.beforeRead);
          await io.check(); const r = await io.revision({ caseId: a.caseId }); await io.check(); return r;
        },
        userWork: {
          async exportAll(q) {
            scope(q.caseId); const { beforeRead, ...request } = q, io = workIO(t, targetIdentity, targetCheck, a.now, beforeRead);
            await io.check(); const snap = await io.work.exportAll(request); await io.check(); return snap;
          },
          async importAll(q) {
            scope(q.caseId); const { beforeCommit, ...request } = q, io = workIO(t, targetIdentity, targetCheck, a.now, beforeCommit);
            await io.check(); const result = await io.work.importAll(request); await io.check(); return result;
          },
          snapshots: {
            async put(q) {
              scope(q.caseId); const { beforeCommit, ...request } = q, io = workIO(t, targetIdentity, targetCheck, a.now, beforeCommit);
              await io.check(); const id = await io.work.snapshots.put(request); await io.check(); return id;
            },
            async get(q) {
              scope(q.caseId); const { beforeRead, ...request } = q, io = workIO(t, targetIdentity, targetCheck, a.now, beforeRead);
              await io.check(); const snap = await io.work.snapshots.get(request); await io.check(); return snap;
            },
          },
        },
      });
    } catch (e) {
      if (codeOf(e) === 'target-not-isolated') throw e;
      // Unprovisioned/missing/unreachable target is never replaced with the live client or an in-memory fallback.
      target = null;
    }
  }
  const policyPort = policy?.visibility;
  const policyCheck = policyPort?.isVisible.bind(policyPort);
  const nativeVisibility = policyCheck ? Object.freeze<VersionVisibilityPort>({
    kind: 'current-policy',
    async isVisible(q) {
      if (q.identity !== a.identity || q.caseId !== a.caseId || q.identity.clientId !== clientId || !RV.test(q.resultsVersion)) return false;
      try {
        await check();
        const allowed = await policyCheck(q);
        await check(); // custom policy IO has the same late-authority boundary as publication IO
        return allowed === true;
      } catch (e) { if (isDenial(e) || codeOf(e) === 'not-found') return false; return unavailable(); }
    },
  }) : visibility;
  const caseAudit = policy?.audit ? policy.audit.caseAudit.bind(policy.audit) : null;
  // Exactly this request's principal, session and case on the existing gate; no Identity a caller supplies is trusted.
  const auditPort: CaseAuditPort | null = caseAudit ? Object.freeze<CaseAuditPort>({
    kind: 'current-policy',
    async requireCaseAudit(q) {
      if (q.identity !== a.identity || q.caseId !== a.caseId || a.identity.kind !== 'verified') throw contractError('forbidden');
      await check();
      try { await caseAudit({ principal: a.identity.principal, sessionId: a.identity.sessionId, caseId: a.caseId }); }
      catch (e) { if (isDenial(e)) throw contractError('forbidden'); return unavailable(); }
      await check(); // the gate's own IO has the same late-authority boundary as publication IO
    },
  }) : null;
  const captured = new Set<string>();
  let capturedAudit: AuditScope | null = null;
  async function evidenceCheck() {
    // Archive selection cannot authorize protected IO, not even an audit-free capture's inventory.
    if (!auditPort) return unavailable();
    await auditPort.requireCaseAudit({ identity: a.identity, caseId: a.caseId });
    if (await s.gate()) return unavailable();
    await check();
  }
  const capture = evidenceLimits ? primaryEvidenceReader({ openPrimary: () => a.resources.db.withSession('first-primary'), clientId, caseId: a.caseId, limits: evidenceLimits, now: a.now, check: evidenceCheck }) : null;
  const nativeEvidence: NativeEvidencePort | null = evidenceLimits ? Object.freeze({
    limits: evidenceLimits, visibility: nativeVisibility, audit: auditPort,
    async capture(q: { audit: AuditScope }) {
      if (q?.audit !== 'none' && (q?.audit !== 'case-audit/1' || !auditPort)) return unavailable();
      captured.clear(); capturedAudit = null;
      await evidenceCheck();
      // Observe exact live version entitlement before fetching the history-sized primary payload. This inventory
      // uses the ordinary service session; only the subsequent atomic capture consumes its fresh first-primary.
      for (const version of await inventory()) {
        if (await nativeVisibility.isVisible({ identity: a.identity, caseId: a.caseId, resultsVersion: version.version_id }) !== true) throw contractError('not-found');
      }
      const c = await capture!(q.audit);
      for (const ref of expectedReferences(c.evidence)) captured.add(canonicalJson(ref));
      capturedAudit = c.evidence.audit;
      return c;
    },
    async userWorkRevision(boundary?: ReadBoundary) {
      const io = workIO(s, a.identity, check, a.now, boundary?.beforeRead);
      await io.check(); const r = await io.revision({ caseId: a.caseId }); await io.check(); return r;
    },
    async read(ref: Omit<ImmutableReference, 'blob' | 'objectVersion' | 'etag'>) {
      if (!captured.has(canonicalJson(ref))) throw contractError('foreign-input');
      const readCheck = async () => {
        if (capturedAudit === null) return unavailable();
        await evidenceCheck();
        if (ref.resultsVersion && await nativeVisibility.isVisible({ identity: a.identity, caseId: a.caseId, resultsVersion: ref.resultsVersion as ResultsVersion }) !== true) throw contractError('not-found');
        await check();
      };
      return readImmutable(s.bucket, ref, limits.maxFileBytes, readCheck);
    },
  }) : null;
  return Object.freeze<RestoreDeps>({ profile: 'production', now: a.now, newId: a.newId, identity: a.identity, store, assets, previews, visibility, userWork, audit: a.audit, objects, limits, nativeEvidence, liveIsolationId: s.deployment.worker, target });
}
