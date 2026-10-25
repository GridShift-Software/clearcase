// The hosted AssetsAccess handle audits a refused preflight under the read it asked for when metadata carries
// `for: 'read'`, and deliverAsset hands the request to get only after that preflight. Unit doubles (see world.ts).
import { describe, expect, it, vi } from 'vitest';
import { deliverAsset } from '../../../src/lib/viewer/hosted/delivery.ts';
import type { AssetRef, AssetsAccess } from '../../../src/lib/server/runtime/contracts.ts';
import { bigPdf, fetchDest, getOriginal, world, type World } from './world.ts';

const FETCH = fetchDest('empty');
const actions = (w: World) => w.events.map((e) => `${e.action} ${e.outcome}`);

// Authority and publication are checked before any row is read, so an unpublished version needs no staged package.
function candidatePreview() {
  const rv = `sha256:${'a'.repeat(64)}`;
  return { rv, asset: { kind: 'preview', caseId: 'case-a', resultsVersion: rv, assetId: 'p1' } as unknown as AssetRef };
}
const request = { method: 'GET' as const, url: new URL('http://127.0.0.1/x'), headers: new Headers(FETCH) };

describe('the hosted handle names the read behind a refused metadata preflight', () => {
  it('audits an ungranted original once as asset.read-original, with no get and no success', async () => {
    const w = world({ grants: ['case-a'] });
    await w.upload('case-b', 'b1', bigPdf('other'));
    const permissive = vi.fn(async () => new Response('LEAKED'));
    const assets: AssetsAccess = { ...w.assets, get: permissive };
    await expect(deliverAsset({ assets, asset: { kind: 'original', caseId: 'case-b', assetId: 'b1' } as unknown as AssetRef, ...request })).rejects.toMatchObject({ code: 'forbidden' });
    expect(permissive).not.toHaveBeenCalled();
    expect(actions(w)).toEqual(['asset.read-original denied']);
  });
  it('audits a candidate (unpublished) preview once as asset.read-preview with its version, with no get and no success', async () => {
    const w = world(), { rv, asset } = candidatePreview();
    const permissive = vi.fn(async () => new Response('LEAKED'));
    await expect(deliverAsset({ assets: { ...w.assets, get: permissive }, asset, ...request })).rejects.toMatchObject({ code: 'forbidden' });
    expect(permissive).not.toHaveBeenCalled();
    expect(actions(w)).toEqual(['asset.read-preview denied']);
    expect(w.events[0]!.version).toBe(rv);
  });
  it('still audits a plain metadata refusal as asset.describe, and a links refusal likewise', async () => {
    const w = world(), { asset } = candidatePreview();
    await expect(w.assets.metadata({ asset })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.assets.links({ asset })).rejects.toMatchObject({ code: 'forbidden' });
    expect(actions(w)).toEqual(['asset.describe denied', 'asset.describe denied']);
  });
  it('records exactly one succeeded read for a granted download and no event from the preflight', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('granted'));
    const r = await getOriginal(w, 'case-a', 'a1', { headers: FETCH, query: '?download=1' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(actions(w)).toEqual(['asset.read-original succeeded']);
  });
  it('keeps the inline sniff probe the only extra read: an inline view still ends in inline headers and an ETag', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('inline'));
    const r = await getOriginal(w, 'case-a', 'a1', { headers: FETCH });
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(actions(w)).toEqual(['asset.read-original succeeded', 'asset.read-original succeeded']);
  });
  it('keeps a missing object 410 recorded as a failed read, not a denial or a describe', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('gone'));
    w.bucket.objects.delete([...w.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!);
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH })).status).toBe(410);
    expect(actions(w)).toEqual(['asset.read-original failed']);
  });
});
