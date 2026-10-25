import type * as C from '../../server/runtime/contracts.ts';
import { codeOf, contractError, isDenial } from '../../server/runtime/errors.ts';
import { sha256 } from '../../server/runtime/ids.ts';
import { servePolicy } from '../../case-package/media.ts';
import type { OpenStorage } from '../../storage/cloud/access.ts';
import { verifiedRead } from '../../storage/cloud/objects.ts';
import type { StorageEvent } from './index.ts';
import { requirePublished } from './versions.ts';

type Located = { sha256: string; size: number; media_type: string; filename: string; object_key: string };
const failed = (): never => { throw contractError('asset-unavailable', true); };
const HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "sandbox; default-src 'none'" };
const isUnavailable = (e: unknown) => codeOf(e) === 'missing-original' || codeOf(e) === 'changed-original';

/** One `bytes=` range of a known size: a single satisfiable range, or null for anything else (answered 416). */
export function singleRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    return n > 0 ? { start: Math.max(0, size - n), end: size - 1 } : null;
  }
  const start = Number(m[1]), end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return Number.isSafeInteger(start) && start < size && start <= end ? { start, end } : null;
}

/**
 * AssetsAccess over one client's R2 bucket. Originals are a case-level input: the case grant alone reaches them, with
 * or without a publication. A preview belongs to one version and is reachable only while that exact version is
 * published and not withdrawn. Every delivery hashes the whole object against its recorded size and SHA-256 before a
 * byte leaves, reauthorizes after the read, and is recorded before it is released; ranges are cut from verified bytes.
 * Objects over the buffered budget are refused, not streamed unverified.
 */
export function createCloudAssets(a: { open: () => Promise<OpenStorage>; identity: C.Identity; record(e: StorageEvent): Promise<void>; viewerRoute?: (asset: C.AssetRef) => string | null }): C.AssetsAccess {
  const { open, identity } = a;
  const versionOf = (asset: C.AssetRef) => (asset.kind === 'preview' ? asset.resultsVersion : null);
  async function authorize(s: OpenStorage, asset: C.AssetRef) {
    await identity.authorize({ caseId: asset.caseId, operation: asset.kind === 'original' ? 'read-original' : 'read-preview' });
    if (asset.kind === 'preview') await requirePublished(s.db, asset.caseId, asset.resultsVersion).catch((e) => { throw codeOf(e) === 'storage-unavailable' ? contractError('asset-unavailable', true) : e; });
  }
  async function located(asset: C.AssetRef): Promise<{ s: OpenStorage; row: Located }> {
    const s = await open();
    await authorize(s, asset);
    const row = asset.kind === 'original'
      ? await s.db.prepare('SELECT o.sha256, o.size, o.object_key, c.media_type, c.filename FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256 WHERE c.case_id = ? AND c.asset_id = ?').bind(asset.caseId, asset.assetId).first<Located>().catch(failed)
      : await s.db.prepare('SELECT p.sha256, p.size, p.object_key, p.media_type, p.filename FROM rs_preview p JOIN rs_results_version v ON v.version_id = p.version_id WHERE p.version_id = ? AND p.asset_id = ? AND v.case_id = ?').bind(asset.resultsVersion, asset.assetId, asset.caseId).first<Located>().catch(failed);
    if (!row) throw contractError('not-found');
    return { s, row };
  }
  const metadata = (r: Located): C.AssetMetadata => ({ size: r.size, sha256: sha256(r.sha256), mediaType: r.media_type, filename: r.filename, objectVersion: `sha256:${r.sha256}`, etag: `"${r.sha256}"` });
  async function read(asset: C.AssetRef) {
    const { s, row } = await located(asset);
    const r = await verifiedRead(s.bucket, row.object_key, row, s.budgets.maxBufferedObjectBytes);
    if (r.kind === 'missing') throw contractError('missing-original');
    if (r.kind === 'changed') throw contractError('changed-original');
    if (r.kind !== 'ok') failed();
    await authorize(s, asset); // authority and publication read again after the slow read
    return { bytes: (r as { bytes: Uint8Array }).bytes, metadata: metadata(row) };
  }
  async function described<T>(asset: C.AssetRef, run: () => Promise<T>, action = 'asset.describe'): Promise<T> {
    try { return await run(); }
    catch (e) {
      if (isDenial(e)) await a.record({ action, object: { kind: 'asset', id: asset.assetId, caseId: asset.caseId }, version: versionOf(asset), outcome: 'denied' }).catch(() => undefined);
      throw e;
    }
  }
  return {
    async originals(scope) {
      const s = await open();
      try { await identity.authorize({ ...scope, operation: 'read-original' }); }
      catch (e) {
        if (isDenial(e)) await a.record({ action: 'asset.list', object: { kind: 'case', id: scope.caseId, caseId: scope.caseId }, version: null, outcome: 'denied' }).catch(() => undefined);
        throw e;
      }
      const { results } = await s.db.prepare('SELECT c.asset_id, c.filename, c.media_type, o.size FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256 WHERE c.case_id = ? ORDER BY c.asset_id').bind(scope.caseId).all<{ asset_id: string; filename: string; media_type: string; size: number }>().catch(failed);
      return results.map((r) => ({ assetId: r.asset_id, filename: r.filename, mediaType: r.media_type, size: r.size }));
    },
    availability: ({ asset }) => described(asset, async () => {
      try { return { kind: 'available', metadata: (await read(asset)).metadata }; }
      catch (e) { if (isUnavailable(e)) return { kind: 'unavailable', reason: codeOf(e) === 'missing-original' ? 'missing' : 'changed', parent: null }; throw e; }
    }),
    metadata: ({ asset, for: intent }) => described(asset, async () => metadata((await located(asset)).row), intent === 'read' ? `asset.${asset.kind === 'original' ? 'read-original' : 'read-preview'}` : 'asset.describe'),
    links: ({ asset }) => described(asset, async () => {
      await located(asset);
      const base = `/cases/${encodeURIComponent(asset.caseId)}`;
      const href = asset.kind === 'original' ? `${base}/originals/${encodeURIComponent(asset.assetId)}` : `${base}/v/${encodeURIComponent(asset.resultsVersion)}/previews/${encodeURIComponent(asset.assetId)}`;
      // The viewer is the composing parent's route (an inline-safe PDF view is not served from here). It is offered only as a path under this case.
      const viewer = a.viewerRoute?.(asset) ?? null;
      return { originalHref: href, downloadHref: `${href}?download=1`, viewerHref: viewer !== null && viewer.startsWith(`${base}/`) && !viewer.includes('//') ? viewer : null };
    }),
    async get({ asset, request }) {
      const action = `asset.${asset.kind === 'original' ? 'read-original' : 'read-preview'}`, object = { kind: 'asset', id: asset.assetId, caseId: asset.caseId }, version = versionOf(asset);
      try {
        const { bytes, metadata: m } = await read(asset);
        const ranged = request.range !== null && (request.ifRange === null || request.ifRange === m.etag);
        const range = ranged ? singleRange(request.range!, bytes.byteLength) : null;
        if (ranged && !range) {
          await a.record({ action, object, version, outcome: 'refused' }).catch(() => undefined);
          return new Response(null, { status: 416, headers: { ...HEADERS, 'content-range': `bytes */${bytes.byteLength}` } });
        }
        // Built before the delivery is recorded, so a header that cannot be built never leaves a recorded delivery with no release.
        // The disposition is the serve policy's own hardened `attachment` form (controls and bidi overrides replaced, a cut
        // name, an ASCII fallback and an RFC 8187 `filename*` that encodes the apostrophe): never a raw encode of the stored name.
        const headers = new Headers(servePolicy(m.mediaType, m.filename).headers);
        for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
        headers.set('content-disposition', servePolicy(m.mediaType, m.filename, true).headers['Content-Disposition']!);
        headers.set('etag', m.etag);
        headers.set('accept-ranges', 'bytes');
        const body = new Uint8Array(range ? bytes.subarray(range.start, range.end + 1) : bytes);
        headers.set('content-length', String(body.byteLength));
        if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
        // Recorded before any byte leaves; an unrecorded delivery is no delivery.
        try { await a.record({ action, object, version, outcome: 'succeeded' }); }
        catch { return new Response(null, { status: 503, headers: { ...HEADERS, 'retry-after': '2' } }); }
        return new Response(request.method === 'HEAD' ? null : body, { status: range ? 206 : 200, headers });
      } catch (e) {
        if (isDenial(e)) await a.record({ action, object, version, outcome: 'denied' }).catch(() => undefined);
        else if (isUnavailable(e)) await a.record({ action, object, version, outcome: 'failed' }).catch(() => undefined);
        throw e;
      }
    },
  };
}
