import type { AssetRef, OriginalEntry, ResultsVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { authorizeAndAudit, recheck as recheckCase, recordAfter, recordFailure, requireCaseId, requireObjects } from './authority.ts';
import { canonicalJson, encode, fail, ID, objectKeys, sha256Hex } from './bytes.ts';
import { DEFAULT_LIMITS, EXPORT_FORMAT, type Accounting, type BlobRef, type EmbeddedRecord, type ExportManifest, type ExportResult, type Limits, type OriginalRecord, type PreviewRecord, type RecoveryDeps, type VersionRecord } from './types.ts';
import { recheckExportAuthority, requireVisibility, requireVisible } from './visibility.ts';
import { auditScopeOf, evidenceVersionIds, evidenceVersions, expectedReferences, nativeAuthorityDeps, nativePort, NATIVE_EXPORT_FORMAT, parseNativeManifest, recheckNative, requireAuditView, verifyNativeBytes, type ImmutableReference, type NativeExportManifest, type NativeExportResult } from './native-evidence.ts';

export interface ExportRequest { caseId: string; exportId: string; includeUserWork: boolean }

/** Opt-in /2. Legacy exportCase remains byte-compatible and keeps its native lineage HOLD. */
export async function exportNativeCase(deps: RecoveryDeps, req: ExportRequest): Promise<NativeExportResult> {
  const port = nativePort(deps), objects = requireObjects(deps), caseId = requireCaseId(req.caseId);
  if (!ID.test(req.exportId) || typeof req.includeUserWork !== 'boolean') throw fail('invalid-request');
  const auth = nativeAuthorityDeps(deps);
  const scopes = [{ caseId, operation: 'read' as const }, { caseId, operation: 'read-original' as const }, { caseId, operation: 'read-preview' as const }];
  const audit = { action: 'recovery.export', objectKind: 'case-export', objectId: req.exportId, caseId };
  await authorizeAndAudit(deps, { ...audit, scopes });
  try {
    const keys = objectKeys(deps.identity.clientId, caseId, req.exportId);
    const scope = auditScopeOf(deps), beforeManifest = () => requireAuditView(deps, { audit: scope }, caseId);
    await beforeManifest();
    if (await objects.get(keys.manifest, { beforeRead: beforeManifest })) throw fail('export-exists');
    await beforeManifest(); // capture ports must enforce this too, before the first protected audit SELECT
    const capture = await port.capture({ audit: scope }), evidence = capture.evidence;
    if (evidence.audit !== scope) throw fail('manifest-invalid');
    const recheckCaptured = async () => {
      await requireAuditView(deps, evidence, caseId);
      for (const id of evidenceVersionIds(evidence)) await requireVisible(auth, caseId, id);
      await recheckCase(deps, scopes);
    };
    await recheckCaptured();
    const versions = evidenceVersions(evidence);
    const expected = expectedReferences(evidence), budget: Budget = { files: 0, bytes: 0, limits: port.limits };
    for (const ref of expected) take(budget, ref.size); // bound every declared reference before touching any protected bytes
    const references: ImmutableReference[] = [], blobs = new Map<string, Uint8Array>();
    const startedAt = deps.now().toISOString();
    for (const ref of expected) {
      await recheckCaptured();
      const { bytes, objectVersion, etag } = await port.read(ref);
      if (bytes.length !== ref.size || await sha256Hex(bytes) !== ref.sha256) throw fail('export-corrupt');
      blobs.set(ref.sha256, bytes);
      references.push({ ...ref, blob: `blobs/${ref.sha256}`, objectVersion, etag });
    }
    const completedAt = deps.now().toISOString();
    let userWork: ExportManifest['userWork'] = null;
    let userWorkObservation: NativeExportManifest['source']['userWork'] = { revision: await port.userWorkRevision({ beforeRead: recheckCaptured }), observedAt: deps.now().toISOString() };
    if (req.includeUserWork) {
      const revision = userWorkObservation.revision;
      await recheckCaptured();
      const snap = await deps.userWork.exportAll({ caseId, beforeRead: recheckCaptured });
      if (await port.userWorkRevision({ beforeRead: recheckCaptured }) !== revision) throw fail('export-raced', true);
      const bytes = encode(canonicalJson(snap)); take(budget, bytes.length);
      const sha256 = await sha256Hex(bytes); blobs.set(sha256, bytes);
      userWork = { sha256, blob: `blobs/${sha256}`, size: bytes.length, exportedAt: snap.exportedAt, tables: snap.tables.length, rows: snap.tables.reduce((n, t) => n + t.rows.length, 0) };
      userWorkObservation = { revision, observedAt: deps.now().toISOString() };
    }
    const originals = references.filter((r) => r.kind === 'original').map((r) => {
      const row = evidence.tables.rs_case_original!.find((o) => o.asset_id === r.assetId)!;
      return { assetId: r.assetId!, filename: String(row.filename), mediaType: String(row.media_type), objectVersion: r.objectVersion, etag: r.etag, sha256: r.sha256, size: r.size, blob: r.blob };
    });
    const previews = references.filter((r) => r.kind === 'preview').map((r) => {
      const row = evidence.tables.rs_preview!.find((p) => p.version_id === r.resultsVersion && p.asset_id === r.assetId)!;
      return { assetId: r.assetId!, resultsVersion: r.resultsVersion as ResultsVersion, filename: String(row.filename), mediaType: String(row.media_type), objectVersion: r.objectVersion, etag: r.etag, sha256: r.sha256, size: r.size, blob: r.blob };
    });
    const resultsVersions = versions.map((version) => ({ version, files: references.filter((r) => r.kind === 'package' && r.resultsVersion === version.id).map((r) => ({ path: r.path!, sha256: r.sha256, size: r.size, blob: r.blob })) }));
    const publicationRow = evidence.tables.rs_publication![0];
    const published = publicationRow?.state === 'published' && !evidence.tables.rs_version_withdrawal!.some((r) => r.version_id === publicationRow.version_id);
    const manifest: NativeExportManifest = {
      format: NATIVE_EXPORT_FORMAT, exportId: req.exportId, clientId: deps.identity.clientId, caseId, createdAt: deps.now().toISOString(),
      createdBy: { issuer: deps.identity.principal!.issuer, subject: deps.identity.principal!.subject, kind: deps.identity.principal!.kind },
      source: { d1: capture.observation, userWork: userWorkObservation, r2: { startedAt, completedAt, atomicWithD1: false },
        publication: published ? { kind: 'published', resultsVersion: publicationRow.version_id as ResultsVersion } : { kind: publicationRow ? 'withdrawn' : 'none' }, activeVersion: published ? publicationRow.version_id as ResultsVersion : null },
      selection: { originals: true, previews: true, resultsPackages: true, userWork: req.includeUserWork }, originals, embedded: [], previews, resultsVersions, userWork,
      evidence, references, accounting: accountOf(originals, [], previews, resultsVersions, userWork),
    };
    const bytes = encode(canonicalJson(manifest));
    await parseNativeManifest(bytes, port.limits);
    await verifyNativeBytes(manifest, blobs);
    const session = deps.identity.sessionId, text = new TextDecoder().decode(bytes);
    if (session && (text.includes(session) || text.includes(await sha256Hex(encode(session))))) throw fail('manifest-invalid');
    const recheck = () => recheckNative(deps, manifest, scopes);
    for (const [sha256, b] of blobs) {
      await recheck();
      await objects.putIfAbsent({ key: `${keys.base}/blobs/${sha256}`, bytes: b, sha256, beforeCommit: recheck });
    }
    for (const [sha, b] of blobs) {
      await recheck();
      const back = await objects.get(`${keys.base}/blobs/${sha}`, { beforeRead: recheck });
      if (!back) throw fail('export-incomplete', true);
      if (back.length !== b.length || await sha256Hex(back) !== sha) throw fail('export-corrupt');
    }
    await recheck();
    const manifestSha256 = await sha256Hex(bytes);
    const result = await objects.putIfAbsent({ key: keys.manifest, bytes, sha256: manifestSha256, beforeCommit: recheck });
    if (result.kind === 'exists') throw fail('export-exists');
    await recheck();
    const back = await objects.get(keys.manifest, { beforeRead: recheck });
    if (!back || await sha256Hex(back) !== manifestSha256 || back.length !== bytes.length) throw fail('export-incomplete', true);
    await recordAfter(deps, { ...audit, outcome: 'succeeded' });
    await recheck();
    return { manifest, manifestSha256, manifestKey: keys.manifest, accounting: manifest.accounting };
  } catch (e) { await recordFailure(deps, audit, e); throw e; }
}
interface Budget { files: number; bytes: number; limits: Limits }
const take = (b: Budget, size: number) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > b.limits.maxFileBytes) throw fail('export-too-large');
  b.files += 1; b.bytes += size;
  if (b.files > b.limits.maxFiles || b.bytes > b.limits.maxTotalBytes) throw fail('export-too-large');
};

/**
 * One case's complete recovery export into the injected durable private store: original bytes, previews of the published
 * version, every results package byte-for-byte with its provenance, and (only when explicitly selected) independent user
 * work. Authority and the required audit record precede every byte; every byte is hashed against the source's own claim;
 * blobs are written and read back before the manifest, which is written last and never overwritten, so a partial export
 * has no manifest and a repeated export id is refused.
 */
export async function exportCase(deps: RecoveryDeps, req: ExportRequest): Promise<ExportResult> {
  const objects = requireObjects(deps);
  requireVisibility(deps);
  const caseId = requireCaseId(req.caseId);
  if (!ID.test(req.exportId) || typeof req.includeUserWork !== 'boolean') throw fail('invalid-request');
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { identity, store, assets } = deps;
  const scopes = [{ caseId, operation: 'read' as const }, { caseId, operation: 'read-original' as const }, { caseId, operation: 'read-preview' as const }];
  const audit = { action: 'recovery.export', objectKind: 'case-export', objectId: req.exportId, caseId };
  await authorizeAndAudit(deps, { ...audit, scopes });
  try {
    const keys = objectKeys(identity.clientId, caseId, req.exportId);
    if (await objects.get(keys.manifest).catch(() => { throw fail('storage-unavailable', true); })) throw fail('export-exists');
    const info = await store.getCase({ caseId });
    if (!info) throw fail('not-found');
    const startRevision = await store.stateRevision({ caseId });
    const startActive = await store.activeVersionId({ caseId });
    const budget: Budget = { files: 0, bytes: 0, limits };
    const blobs = new Map<string, Uint8Array>();
    const stage = async (bytes: Uint8Array): Promise<BlobRef> => {
      const sha256 = await sha256Hex(bytes);
      if (!blobs.has(sha256)) blobs.set(sha256, bytes);
      return { sha256, size: bytes.length, blob: `blobs/${sha256}` };
    };

    // Declared sizes bound the work before the first byte is read.
    const listed = await assets.originals({ caseId });
    for (const o of listed) { if (!ID.test(o.assetId)) throw fail('foreign-input'); }
    const originals: OriginalRecord[] = []; const embedded: EmbeddedRecord[] = [];
    for (const entry of listed) {
      const asset: AssetRef = { kind: 'original', caseId, assetId: entry.assetId };
      const av = await assets.availability({ asset });
      if (av.kind === 'unavailable') {
        if (av.reason === 'embedded') { embedded.push({ assetId: entry.assetId, filename: entry.filename, mediaType: entry.mediaType, size: entry.size, unavailable: 'embedded' }); continue; }
        throw contractError(av.reason === 'missing' ? 'missing-original' : 'changed-original', false);
      }
      take(budget, av.metadata.size);
      originals.push(await readAsset(deps, asset, entry, av.metadata, stage) as OriginalRecord);
    }

    const published = info.publication.kind === 'published' ? info.publication.resultsVersion : null;
    const previews: PreviewRecord[] = [];
    if (published) {
      await requireVisible(deps, caseId, published);
      if (!deps.previews) throw fail('recovery-unavailable', true);
      const entries = await deps.previews.previewsOf({ caseId, resultsVersion: published });
      for (const entry of entries) {
        if (!ID.test(entry.assetId)) throw fail('foreign-input');
        const asset: AssetRef = { kind: 'preview', caseId, resultsVersion: published, assetId: entry.assetId };
        const av = await assets.availability({ asset });
        if (av.kind === 'unavailable') throw contractError(av.reason === 'missing' ? 'missing-original' : 'changed-original', false);
        take(budget, av.metadata.size);
        previews.push({ ...(await readAsset(deps, asset, entry, av.metadata, stage)), resultsVersion: published });
      }
    }

    const resultsVersions: VersionRecord[] = [];
    for (const version of await store.versionsOf({ caseId })) {
      if (version.case_id !== caseId) throw fail('foreign-input');
      await requireVisible(deps, caseId, version.id);
      const scope = { caseId, resultsVersion: version.id };
      const verdict = await store.verifyVersion(scope);
      if (!verdict.ok) throw fail('package-corrupt');
      const files = [];
      for (const path of await store.packageFilePaths(scope)) {
        const bytes = await store.packageFile({ ...scope, path });
        if (!bytes) throw fail('package-corrupt');
        take(budget, bytes.length);
        files.push({ path, ...(await stage(bytes)) });
      }
      resultsVersions.push({ version: structuredClone(version), files });
    }

    let userWork: ExportManifest['userWork'] = null;
    if (req.includeUserWork) {
      const snap = await deps.userWork.exportAll({ caseId });
      const bytes = encode(canonicalJson(snap));
      take(budget, bytes.length);
      userWork = { ...(await stage(bytes)), exportedAt: snap.exportedAt, tables: snap.tables.length, rows: snap.tables.reduce((n, t) => n + t.rows.length, 0) };
    }

    // The case must not have moved while bytes were being read: a torn export is refused, never labelled complete.
    if ((await store.stateRevision({ caseId })) !== startRevision || (await store.activeVersionId({ caseId })) !== startActive) throw fail('export-raced', true);
    const again = await store.getCase({ caseId });
    if (again?.publication.kind !== info.publication.kind || (again.publication.kind === 'published' && published !== again.publication.resultsVersion)) throw fail('export-raced', true);

    const manifest: ExportManifest = {
      format: EXPORT_FORMAT, exportId: req.exportId, clientId: identity.clientId, caseId, createdAt: deps.now().toISOString(),
      createdBy: { issuer: identity.principal!.issuer, subject: identity.principal!.subject, kind: identity.principal!.kind },
      source: { caseRevision: startRevision, publication: structuredClone(info.publication), activeVersion: startActive },
      selection: { originals: true, previews: true, resultsPackages: true, userWork: req.includeUserWork },
      originals, embedded, previews, resultsVersions, userWork, accounting: accountOf(originals, embedded, previews, resultsVersions, userWork),
    };
    const manifestBytes = encode(canonicalJson(manifest));
    // Never a credential or session token: the manifest is built from an allow-list, and this refuses a leak into it anyway.
    if (identity.sessionId && new TextDecoder().decode(manifestBytes).includes(identity.sessionId)) throw fail('manifest-invalid');

    for (const [sha, bytes] of blobs) {
      const key = `${keys.base}/blobs/${sha}`;
      await objects.putIfAbsent({ key, bytes, sha256: sha, beforeCommit: () => recheckExportAuthority(deps, manifest, scopes) }).catch(() => { throw fail('storage-unavailable', true); }); // an existing blob is accepted only if the read-back below proves it is these exact bytes
    }
    for (const [sha, bytes] of blobs) {
      const back = await objects.get(`${keys.base}/blobs/${sha}`).catch(() => { throw fail('storage-unavailable', true); });
      if (!back) throw fail('export-incomplete', true);
      if (back.length !== bytes.length || await sha256Hex(back) !== sha) throw fail('export-corrupt');
    }
    const manifestSha256 = await sha256Hex(manifestBytes);
    await recheckExportAuthority(deps, manifest, scopes);
    const put = await objects.putIfAbsent({ key: keys.manifest, bytes: manifestBytes, sha256: manifestSha256, beforeCommit: () => recheckExportAuthority(deps, manifest, scopes) }).catch(() => { throw fail('storage-unavailable', true); });
    if (put.kind === 'exists') throw fail('export-exists');
    await recordAfter(deps, { ...audit, outcome: 'succeeded' });
    await recheckExportAuthority(deps, manifest, scopes);
    return { manifest, manifestSha256, manifestKey: keys.manifest, accounting: manifest.accounting };
  } catch (e) {
    await recordFailure(deps, audit, e);
    throw e;
  }
}

async function readAsset(deps: RecoveryDeps, asset: AssetRef, entry: OriginalEntry, meta: { size: number; sha256: string; mediaType: string; filename: string; objectVersion: string; etag: string }, stage: (b: Uint8Array) => Promise<BlobRef>) {
  const res = await deps.assets.get({ asset, request: { method: 'GET', range: null, ifRange: null } });
  if (res.status !== 200) throw contractError('asset-unavailable', true);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Actual bytes against the asset's own metadata and the listing: a size or digest that disagrees is a changed original.
  if (bytes.length !== meta.size || entry.size !== meta.size || await sha256Hex(bytes) !== meta.sha256) throw contractError('changed-original', false);
  const blob = await stage(bytes);
  return { assetId: entry.assetId, filename: meta.filename, mediaType: meta.mediaType, objectVersion: meta.objectVersion, etag: meta.etag, ...blob };
}

export function accountOf(originals: readonly OriginalRecord[], embedded: readonly EmbeddedRecord[], previews: readonly PreviewRecord[], versions: readonly VersionRecord[], userWork: ExportManifest['userWork']): Accounting {
  const sum = (xs: readonly { size: number }[]) => xs.reduce((n, x) => n + x.size, 0);
  const files = versions.flatMap((v) => v.files);
  const distinct = new Map<string, number>();
  for (const x of [...originals, ...previews, ...files, ...(userWork ? [userWork] : [])]) distinct.set(x.sha256, x.size);
  return {
    originals: { files: originals.length, bytes: sum(originals), embedded: embedded.length }, previews: { files: previews.length, bytes: sum(previews) },
    resultsPackages: { versions: versions.length, files: files.length, bytes: sum(files) },
    userWork: { included: userWork !== null, tables: userWork?.tables ?? 0, rows: userWork?.rows ?? 0, bytes: userWork?.size ?? 0 },
    blobs: { distinct: distinct.size, bytes: [...distinct.values()].reduce((a, b) => a + b, 0) },
  };
}
