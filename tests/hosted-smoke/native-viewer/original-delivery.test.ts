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
