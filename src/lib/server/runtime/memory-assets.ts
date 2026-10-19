import type * as C from './contracts.ts';
import type { MemoryContext } from './memory.ts';
import { copy, digest } from './data.ts';
import { contractError } from './errors.ts';
import { servePolicy } from '../../case-package/media.ts';
export function createMemoryAssets(ctx: MemoryContext, fault: (asset: C.AssetRef) => 'missing' | 'changed' | null): C.AssetsAccess {
  async function read(asset: C.AssetRef) {
    await ctx.before('asset');
    await authorize(asset);
    const a = ctx.client.assets.find((a) => a.ref.kind === asset.kind && a.ref.caseId === asset.caseId && a.ref.assetId === asset.assetId && (a.ref.kind === 'original' || asset.kind === 'preview' && a.ref.resultsVersion === asset.resultsVersion));
    const reason = fault(asset);
    if (!a || reason === 'missing') throw contractError('missing-original');
    const bytes = new Uint8Array(a.bytes);
    if (reason === 'changed' && bytes.length) bytes[bytes.length - 1] ^= 1;
    if (bytes.length !== a.metadata.size || await digest(bytes) !== a.metadata.sha256) throw contractError('changed-original');
    await authorize(asset);
    return { bytes, metadata: copy(a.metadata) };
  }
  async function authorize(asset: C.AssetRef) {
    await ctx.identity.authorize({ caseId: asset.caseId, operation: asset.kind === 'original' ? 'read-original' : 'read-preview' });
    if (asset.kind === 'preview') {
      const p = ctx.client.cases.find((c) => c.caseId === asset.caseId)?.publication;
      if (p?.kind !== 'published' || p.resultsVersion !== asset.resultsVersion) throw contractError('forbidden');
    }
  }
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
  return {
    async availability({ asset }) {
      try { return { kind: 'available', metadata: (await read(asset)).metadata }; }
      catch (e) { if (e instanceof Error && 'code' in e && (e.code === 'missing-original' || e.code === 'changed-original')) return { kind: 'unavailable', reason: e.code === 'missing-original' ? 'missing' : 'changed', parent: null }; throw e; }
    },
    async metadata({ asset }) { return (await read(asset)).metadata; },
    async links({ asset }) { await read(asset); const href = `/cases/${encodeURIComponent(asset.caseId)}/assets/${encodeURIComponent(asset.assetId)}`; return { originalHref: href, downloadHref: `${href}?download=1`, viewerHref: null }; },
    async get({ asset, request }) {
      try {
        const { bytes, metadata: m } = await read(asset);
        const safe = new Headers(servePolicy(m.mediaType, m.filename).headers);
        for (const [name, value] of Object.entries(headers)) safe.set(name, value);
        safe.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`);
        safe.set('content-length', String(bytes.length)); safe.set('etag', m.etag);
        if (request.range && (request.ifRange === null || request.ifRange === m.etag)) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } });
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: safe });
      } catch (e) {
        if (e instanceof Error && 'code' in e && (e.code === 'missing-original' || e.code === 'changed-original')) return new Response(null, { status: 410, headers });
        throw e;
      }
    },
  };
}
