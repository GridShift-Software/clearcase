// GRS native viewer: the adverse HTTP contract of the protected original route. Component evidence over unit doubles
// (see world.ts); not a hosted, browser or native PASS. Synthetic bytes only.
import { describe, expect, it } from 'vitest';
import { bigPdf, fetchDest, getOriginal, html, png, world } from './world.ts';

const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const FETCH = fetchDest('empty');

describe('an authorized original is shown in the app only through a fetch, never as a navigable document', () => {
  it('serves a PDF to the in-app viewer inline, sandboxed and nosniff, with its validators', async () => {
    const w = world(), pdf = bigPdf('inline');
    await w.upload('case-a', 'a1', pdf);
    const r = await getOriginal(w, 'case-a', 'a1', { headers: FETCH });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-security-policy')).toMatch(/^sandbox;/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await bytes(r)).toEqual(pdf);
  });

  it.each(['document', 'iframe', 'embed', 'object', 'frame', 'fencedframe', undefined])('downloads instead of rendering when the PDF is navigated to (sec-fetch-dest %s)', async (dest) => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('nav'));
    const r = await getOriginal(w, 'case-a', 'a1', { headers: dest ? fetchDest(dest) : {} });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('serves an image to an <img> inline and downloads it when navigated to', async () => {
    const w = world();
    await w.upload('case-a', 'i1', png(), { filename: 'scan.png', mediaType: 'image/png' });
    const inline = await getOriginal(w, 'case-a', 'i1', { headers: fetchDest('image') });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect((await getOriginal(w, 'case-a', 'i1', { headers: fetchDest('document') })).headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('keeps ?download=1 a download whatever the destination', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('dl'));
    const r = await getOriginal(w, 'case-a', 'a1', { headers: FETCH, query: '?download=1' });
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('never offers an inline form for bytes that contradict the declared type, even on a ranged read past the head', async () => {
    const w = world();
    await w.upload('case-a', 'h1', html(), { filename: 'letter.pdf', mediaType: 'application/pdf' });
    const whole = await getOriginal(w, 'case-a', 'h1', { headers: FETCH });
    expect(whole.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(whole.headers.get('content-security-policy')).toMatch(/^sandbox;/);
    const tail = await getOriginal(w, 'case-a', 'h1', { headers: { ...FETCH, range: 'bytes=10-20' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('never serves a type whose serve policy is download-only inline, whatever the declared name', async () => {
    const w = world();
    await w.upload('case-a', 'd1', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), { filename: 'memo.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect((await getOriginal(w, 'case-a', 'd1', { headers: FETCH })).headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('ranges are cut from verified bytes and validated', () => {
  const FETCHED = { ...FETCH };
  it('answers a single range 206 with the exact slice and Content-Range', async () => {
    const w = world(), pdf = bigPdf('range');
    await w.upload('case-a', 'a1', pdf);
    const r = await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${pdf.byteLength}`);
    expect(r.headers.get('content-length')).toBe('100');
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(await bytes(r)).toEqual(pdf.subarray(100, 200));
  });
  it('answers a suffix range and an open-ended range from the same verified bytes', async () => {
    const w = world(), pdf = bigPdf('suffix');
    await w.upload('case-a', 'a1', pdf);
    expect(await bytes(await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range: 'bytes=-16' } }))).toEqual(pdf.subarray(pdf.byteLength - 16));
    expect(await bytes(await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range: `bytes=${pdf.byteLength - 4}-` } }))).toEqual(pdf.subarray(pdf.byteLength - 4));
  });
  it.each(['bytes=99999-', 'bytes=5-2', 'bytes=0-1,5-9', 'items=0-1', 'bytes=-0', 'bytes=a-b'])('answers %s 416 with no body and the object size', async (range) => {
    const w = world(), pdf = bigPdf('416');
    await w.upload('case-a', 'a1', pdf);
    const r = await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range } });
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${pdf.byteLength}`);
    expect((await bytes(r)).byteLength).toBe(0);
  });
  it('honours If-Range: the current ETag keeps the range, any other validator (weak, stale, a date) gets the whole object', async () => {
    const w = world(), pdf = bigPdf('ifrange');
    await w.upload('case-a', 'a1', pdf);
    const etag = (await getOriginal(w, 'case-a', 'a1', { headers: FETCHED })).headers.get('etag')!;
    const kept = await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range: 'bytes=0-9', 'if-range': etag } });
    expect(kept.status).toBe(206);
    for (const stale of [`W/${etag}`, '"0000"', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const r = await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCHED, range: 'bytes=0-9', 'if-range': stale } });
      expect(r.status).toBe(200);
      expect(await bytes(r)).toEqual(pdf);
    }
  });
  it('answers HEAD with the headers of the GET and no body, and never leaves an inline form on a download', async () => {
    const w = world(), pdf = bigPdf('head');
    await w.upload('case-a', 'a1', pdf);
    const g = await getOriginal(w, 'case-a', 'a1', { headers: FETCHED }), h = await getOriginal(w, 'case-a', 'a1', { headers: FETCHED, method: 'HEAD' });
    expect(h.status).toBe(200);
    expect((await bytes(h)).byteLength).toBe(0);
    expect(h.headers.get('content-length')).toBe(String(pdf.byteLength));
    expect(h.headers.get('etag')).toBe(g.headers.get('etag'));
    expect(h.headers.get('content-disposition')).toBe(g.headers.get('content-disposition'));
  });
});

describe('authority, revocation and absence release no byte', () => {
  const none = async (r: Response, status: number) => { expect(r.status).toBe(status); expect(await r.text()).not.toContain('SYNTHETIC'); };
  it('answers an ungranted case 404 and records the denial, though the asset id exists in another case', async () => {
    const w = world({ grants: ['case-a'] });
    await w.upload('case-b', 'b1', bigPdf('other'));
    const r = await getOriginal(w, 'case-b', 'b1', { headers: FETCH });
    await none(r, 404);
    expect(w.events.some((e) => e.outcome === 'denied' && e.object.caseId === 'case-b')).toBe(true);
    expect(w.events.some((e) => e.outcome === 'succeeded')).toBe(false);
  });
  it('does not let a granted case reach another case’s asset by naming its id', async () => {
    const w = world({ grants: ['case-a', 'case-b'] });
    await w.upload('case-b', 'b1', bigPdf('b-only'));
    await none(await getOriginal(w, 'case-a', 'b1', { headers: FETCH }), 404);
  });
  it('stops serving the moment the grant is revoked, ranged reads included', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('revoke'));
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH })).status).toBe(200);
    w.who.grants.delete('case-a');
    await none(await getOriginal(w, 'case-a', 'a1', { headers: { ...FETCH, range: 'bytes=0-9' } }), 404);
    await none(await getOriginal(w, 'case-a', 'a1', { headers: FETCH, method: 'HEAD' }), 404);
  });
  it.each(['..', 'a/b', '%2e%2e', 'x'.repeat(200), ''])('treats the malformed asset id %j as absent without touching storage', async (assetId) => {
    const w = world();
    const gets = w.bucket.gets;
    await none(await getOriginal(w, 'case-a', assetId, { headers: FETCH }), 404);
    expect(w.bucket.gets).toBe(gets);
  });
  it('answers a missing object 410 with no body and records the failure', async () => {
    const w = world(), pdf = bigPdf('gone');
    await w.upload('case-a', 'a1', pdf);
    const key = [...w.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    w.bucket.objects.delete(key);
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH })).status).toBe(410);
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH, query: '?download=1' })).status).toBe(410);
    expect(w.events.some((e) => e.outcome === 'failed')).toBe(true);
    expect(w.events.some((e) => e.outcome === 'succeeded')).toBe(false);
  });
  it('answers a changed object 410 on every route into it: whole, ranged, HEAD, download', async () => {
    const w = world(), pdf = bigPdf('rot');
    await w.upload('case-a', 'a1', pdf);
    const key = [...w.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    w.bucket.tamper(key, (b) => { b[b.length - 20]! ^= 1; return b; });
    for (const o of [{ headers: FETCH }, { headers: { ...FETCH, range: 'bytes=0-9' } }, { headers: FETCH, method: 'HEAD' as const }, { headers: FETCH, query: '?download=1' }]) {
      const r = await getOriginal(w, 'case-a', 'a1', o);
      expect(r.status).toBe(410);
      expect((await r.text()).includes('SYNTHETIC')).toBe(false);
    }
  });
  it('answers 503 with no byte when the delivery cannot be recorded', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('audit'));
    const failing = createFailingAudit(w);
    const r = await getOriginal(w, 'case-a', 'a1', { headers: FETCH, assets: failing });
    expect(r.status).toBe(503);
    expect((await bytes(r)).byteLength).toBe(0);
  });
  it('answers 503 on every route when the assets port is not connected', async () => {
    const { createUnavailableServices } = await import('../../../src/lib/server/runtime/unavailable.ts');
    const { ids } = await import('./world.ts');
    const u = createUnavailableServices({ clientId: ids.clientA, now: () => new Date() });
    const w = world();
    for (const headers of [FETCH, { ...FETCH, range: 'bytes=0-1' }, {}]) expect((await getOriginal(w, 'case-a', 'a1', { headers, assets: u.assets })).status).toBe(503);
  });
});

import type { World } from './world.ts';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { BUDGETS } from '../../hosted-foundation/storage/fixture.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { CaseRevision } from '../../../src/lib/server/runtime/contracts.ts';
/** The same real assets over the same storage, with an audit sink that cannot append. */
function createFailingAudit(w: World) {
  return createCloudResults({
    bindings: w.bindings, clientId: id('client', 'client-a'), budgets: BUDGETS, identity: w.who.identity,
    record: async () => { throw new Error('audit down'); },
    stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision,
  }).assets;
}
