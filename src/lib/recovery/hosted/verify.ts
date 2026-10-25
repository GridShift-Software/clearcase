import type { CaseId } from '../../server/runtime/contracts.ts';
import { authorizeAndAudit, recordAfter, requireCaseId, requireObjects } from './authority.ts';
import { canonicalJson, fail, ID, objectKeys, SHA, sha256Hex } from './bytes.ts';
import { accountOf } from './export.ts';
import { DEFAULT_LIMITS, EXPORT_FORMAT, type ExportManifest, type Limits, type RecoveryDeps } from './types.ts';

export type VerifyDeps = Pick<RecoveryDeps, 'profile' | 'now' | 'newId' | 'identity' | 'audit' | 'objects' | 'limits'>;
export interface VerifyRequest { caseId: string; exportId: string; expectedManifestSha256: string }
export interface Verified { manifest: ExportManifest; manifestSha256: string; blobs: ReadonlyMap<string, Uint8Array>; accounting: ExportManifest['accounting'] }
const KEYS = ['format', 'exportId', 'clientId', 'caseId', 'createdAt', 'createdBy', 'source', 'selection', 'originals', 'embedded', 'previews', 'resultsVersions', 'userWork', 'accounting'];
const bad = () => fail('manifest-invalid');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown): v is { sha256: string; size: number; blob: string } => isObj(v) && typeof v.sha256 === 'string' && SHA.test(v.sha256) && Number.isSafeInteger(v.size) && (v.size as number) >= 0 && v.blob === `blobs/${v.sha256}`;

/** Strict shape check of a stored manifest, including that its accounting equals what its own entries sum to. */
export function parseManifest(bytes: Uint8Array): ExportManifest {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw bad(); }
  if (!isObj(raw) || raw.format !== EXPORT_FORMAT) throw bad();
  if (Object.keys(raw).length !== KEYS.length || !KEYS.every((k) => k in raw)) throw bad();
  if (typeof raw.exportId !== 'string' || !ID.test(raw.exportId) || typeof raw.clientId !== 'string' || !ID.test(raw.clientId) || typeof raw.caseId !== 'string' || !ID.test(raw.caseId) || typeof raw.createdAt !== 'string') throw bad();
  if (!Array.isArray(raw.originals) || !Array.isArray(raw.embedded) || !Array.isArray(raw.previews) || !Array.isArray(raw.resultsVersions)) throw bad();
  if (!isObj(raw.selection) || typeof raw.selection.userWork !== 'boolean' || (raw.userWork === null) === raw.selection.userWork) throw bad();
  if (raw.userWork !== null && !(isRef(raw.userWork) && Number.isSafeInteger((raw.userWork as unknown as { tables: number }).tables) && Number.isSafeInteger((raw.userWork as unknown as { rows: number }).rows))) throw bad();
  const dup = new Set<string>();
  for (const o of [...raw.originals, ...raw.previews]) { if (!isRef(o) || typeof (o as { assetId?: unknown }).assetId !== 'string') throw bad(); }
  for (const o of raw.originals as { assetId: string }[]) { if (dup.has(o.assetId)) throw bad(); dup.add(o.assetId); }
  for (const v of raw.resultsVersions) {
    if (!isObj(v) || !isObj(v.version) || !Array.isArray(v.files)) throw bad();
    const paths = new Set<string>();
    for (const f of v.files as unknown[]) { const path = (f as { path?: unknown } | null)?.path; if (!isRef(f) || typeof path !== 'string' || paths.has(path)) throw bad(); paths.add(path); }
  }
  const m = raw as unknown as ExportManifest;
  if (canonicalJson(accountOf(m.originals, m.embedded, m.previews, m.resultsVersions, m.userWork)) !== canonicalJson(m.accounting)) throw bad();
  return m;
}

/**
 * Re-reads an export from the private store and proves it: the stored manifest bytes equal the pinned digest, every entry's blob
 * exists with its exact size and SHA-256, and the per-category accounting holds. Missing manifest or blob is a partial export; a
 * differing byte is a corrupt one; neither is ever reported as complete. Foreign or revoked callers are refused before any blob.
 */
export async function loadExport(deps: VerifyDeps, req: VerifyRequest, scopesFor: (c: CaseId) => Parameters<typeof authorizeAndAudit>[1]['scopes'], action: string): Promise<Verified & { caseId: CaseId }> {
  const objects = requireObjects(deps);
  const caseId = requireCaseId(req.caseId);
  if (!ID.test(req.exportId) || !SHA.test(req.expectedManifestSha256)) throw fail('invalid-request');
  await authorizeAndAudit(deps, { action, objectKind: 'case-export', objectId: req.exportId, caseId, scopes: scopesFor(caseId) });
  const audit = { action, objectKind: 'case-export', objectId: req.exportId, caseId };
  try {
    const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
    const keys = objectKeys(deps.identity.clientId, caseId, req.exportId);
    const get = (k: string) => objects.get(k).catch(() => { throw fail('storage-unavailable', true); });
    const mbytes = await get(keys.manifest);
    if (!mbytes) throw fail('export-incomplete');
    const manifestSha256 = await sha256Hex(mbytes);
    if (manifestSha256 !== req.expectedManifestSha256) throw fail('manifest-mismatch');
    const manifest = parseManifest(mbytes);
    if (new TextDecoder().decode(mbytes) !== canonicalJson(manifest)) throw fail('manifest-invalid'); // canonical bytes only
    if (manifest.caseId !== caseId || manifest.clientId !== deps.identity.clientId || manifest.exportId !== req.exportId) throw fail('foreign-input');
    const entries = [...manifest.originals, ...manifest.previews, ...manifest.resultsVersions.flatMap((v) => v.files), ...(manifest.userWork ? [manifest.userWork] : [])];
    if (entries.length > limits.maxFiles || entries.some((e) => e.size > limits.maxFileBytes)) throw fail('export-too-large');
    const distinct = new Map<string, number>();
    for (const e of entries) { if (distinct.has(e.sha256) && distinct.get(e.sha256) !== e.size) throw fail('manifest-invalid'); distinct.set(e.sha256, e.size); }
    if ([...distinct.values()].reduce((a, b) => a + b, 0) > limits.maxTotalBytes) throw fail('export-too-large');
    const blobs = new Map<string, Uint8Array>();
    for (const [sha, size] of distinct) {
      const bytes = await get(`${keys.base}/blobs/${sha}`);
      if (!bytes) throw fail('export-incomplete');
      if (bytes.length !== size || await sha256Hex(bytes) !== sha) throw fail('export-corrupt');
      blobs.set(sha, bytes);
    }
    return { manifest, manifestSha256, blobs, accounting: manifest.accounting, caseId };
  } catch (e) {
    await recordAfter(deps, { ...audit, outcome: 'failed' });
    throw e;
  }
}
export const exportScopes = (caseId: CaseId) => [{ caseId, operation: 'read' as const }, { caseId, operation: 'read-original' as const }, { caseId, operation: 'read-preview' as const }];
export async function verifyExport(deps: VerifyDeps, req: VerifyRequest) {
  const v = await loadExport(deps, req, exportScopes, 'recovery.verify');
  await recordAfter(deps, { action: 'recovery.verify', objectKind: 'case-export', objectId: req.exportId, caseId: v.caseId, outcome: 'succeeded' });
  return { manifest: v.manifest, manifestSha256: v.manifestSha256, accounting: v.accounting, verifiedBlobs: v.blobs.size };
}
