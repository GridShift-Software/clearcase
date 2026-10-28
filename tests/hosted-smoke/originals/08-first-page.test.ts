// GRS-251 first page: the reviewed reader and the real pinned pdf.js open a synthetic original through a fetch double that
// logs every request. Each request to the original route costs a round trip before its first byte, so the reader must not
// chain them: a file up to 512 KiB is one plain GET, and a larger one starts its tail (where a file that is not linearized
// keeps its cross-reference table) together with the stream, not after the stream's headers.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { DOMMatrix, ImageData, Path2D, createCanvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';

const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';
/** A three-page PDF that is not linearized: pages first, `filler` bytes of content in the middle, the xref table last.
 *  `count` is the page tree's /Count, which a malformed file gets wrong. */
function pdf(filler: number, count = '3') {
  return build(['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count ${count} >>`,
    ...[6, 6, 7].map((c) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${c} 0 R >>`),
    '<< /Length 15 >>\nstream\n0 0 20 20 re f\nendstream', `<< /Length ${filler} >>\nstream\n${' '.repeat(filler)}\nendstream`]);
}
/** `pages` pages under one flat /Kids, each page's dictionary followed by `gap` bytes of its own content, the xref table
 *  last: the layout of a large scanned bundle, where reaching the last page means reading through the whole file. */
function spread(pages: number, gap: number) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + 2 * i} 0 R`).join(' ');
  return build(['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, (_, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${4 + 2 * i} 0 R >>`,
      `<< /Length ${gap + 15} >>\nstream\n0 0 20 20 re f\n${' '.repeat(gap)}\nendstream`]).flat()]);
}
function build(objects: string[]) {
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

type Logged = { range: string | null; at: number };
let bytes = new Uint8Array(), log: Logged[] = [], inFlightAtFirstAnswer: Logged[] | null = null, refuseRanges = false, t0 = 0;
/** Extra wait for a range that starts in the middle of the file, and the pause between 64 KiB pieces of the stream. */
let slowMiddle: { from: number; to: number; ms: number } | null = null, pace = 10;
const ROUND_TRIP = 40;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The original route as the browser sees it: every answer waits a round trip, a whole-file body arrives in 64 KiB pieces. */
async function original(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (String(input) !== SRC) throw new Error(`unexpected fetch ${String(input)}`);
  const range = new Headers(init.headers).get('range');
  log.push({ range, at: Math.round(performance.now() - t0) });
  await wait(ROUND_TRIP);
  inFlightAtFirstAnswer ??= [...log];
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const common = { 'accept-ranges': 'bytes', 'content-type': 'application/pdf', etag: '"e"' };
  if (range) {
    if (refuseRanges) return new Response(null, { status: 412, headers: common });
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    if (slowMiddle && Number(a) >= slowMiddle.from && Number(a) < slowMiddle.to) await wait(slowMiddle.ms);
    const part = bytes.slice(Number(a), Number(b) + 1);
    return new Response(part, { status: 206, headers: { ...common, 'content-length': String(part.byteLength), 'content-range': `bytes ${a}-${Number(a) + part.byteLength - 1}/${bytes.byteLength}` } });
  }
  const whole = bytes;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    await wait(pace);
    if (at >= whole.byteLength) return c.close();
    c.enqueue(whole.slice(at, at += 65536));
  } });
  return new Response(body, { status: 200, headers: { ...common, 'content-length': String(whole.byteLength) } });
}

let assets: ReturnType<typeof generatePdfAssets>;
beforeAll(async () => {
  assets = generatePdfAssets();
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, fetch: original, window: Object.assign(new EventTarget(), {
    requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }) });
  await import(/* @vite-ignore */ join(assets.dir, 'pdf-reader.mjs'));
});
afterAll(() => assets?.dispose());
beforeEach(() => { log = []; inFlightAtFirstAnswer = null; refuseRanges = false; slowMiddle = null; pace = 10; t0 = performance.now(); });
const open = (size: number, onPages?: (pages: number) => void) => (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<{ pages: number; draw(n: number, s: number): Promise<void>; destroy(): void }> } } })
  .window.clearcasePdfReader.open({ src: SRC, size, canvas: createCanvas(100, 100), signal: new AbortController().signal, onPages });

it('opens a 300 KiB original with one plain GET and no range request', async () => {
  bytes = pdf(300 * 1024);
  const reader = await open(bytes.byteLength);
  await reader.draw(1, 1);
  reader.destroy();
  expect(reader.pages).toBe(3);
  expect(log.map((l) => l.range)).toEqual([null]);
});

it('starts the tail of a 3 MiB original with the stream, so its xref costs no round trip after the first', async () => {
  bytes = pdf(3 * 1024 * 1024);
  const size = bytes.byteLength, started = performance.now();
  const reader = await open(size);
  await reader.draw(1, 1);
  const ms = performance.now() - started;
  reader.destroy();
  expect(reader.pages).toBe(3);
  // Every request was already in flight before the first answer arrived, the tail among them: none is chained behind
  // the stream's headers or behind another range, so the first page costs about one round trip, not one per chunk.
  expect(log).toEqual(inFlightAtFirstAnswer);
  expect(log.map((l) => l.range)).toContain(`bytes=${Math.floor((size - 2 ** 20) / 2 ** 18) * 2 ** 18}-${size - 1}`);
  expect(log.map((l) => l.range)).toContain(null);
  expect(ms).toBeLessThan(ROUND_TRIP * 3);
});

it('ends the open with an error when the original refuses a range, so the viewer offers its download link', async () => {
  bytes = pdf(3 * 1024 * 1024); refuseRanges = true;
  await expect(open(bytes.byteLength)).rejects.toThrow();
});

it('draws page 1 of a flat 40-page tree spread over 10 MiB without waiting for the last-page walk', async () => {
  bytes = spread(40, 256 * 1024);
  const size = bytes.byteLength;
  // Every range through the middle of the file (where pages 2 to 40 keep their dictionaries) answers 2.5 s late, and the
  // stream is too slow to bring them sooner. Upstream pdf.js 6.4.299 walks to page 40 before the document opens, so it
  // cannot open in less than 2.5 s; the served worker opens and draws page 1 from the head and the tail alone.
  slowMiddle = { from: 2 ** 18, to: Math.floor((size - 2 ** 20) / 2 ** 18) * 2 ** 18, ms: 2500 }; pace = 40;
  const started = performance.now();
  const reader = await open(size);
  await reader.draw(1, 1);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(reader.pages).toBe(40);
  // The rest of the document is still there once its bytes arrive.
  await reader.draw(40, 1);
  reader.destroy();
});

// A malformed page tree: upstream pdf.js recovers the real page count in checkLastPage, which the served worker defers.
it('opens a 3-page original whose /Count is not a number, as upstream pdf.js does', async () => {
  bytes = pdf(1024, '/Bogus');
  const reader = await open(bytes.byteLength);
  expect(reader.pages).toBe(3);
  await reader.draw(3, 1);
  reader.destroy();
});

it('tells the viewer the real page count once the deferred check finds /Count 10 over 3 pages', async () => {
  bytes = pdf(1024, '10');
  let told: (pages: number) => void;
  const corrected = new Promise<number>((resolve) => { told = resolve; });
  const reader = await open(bytes.byteLength, (pages) => told(pages));
  // A numeric /Count keeps the fast path: the document opens on /Count, before the last-page check.
  expect(reader.pages).toBe(10);
  await reader.draw(1, 1);
  await expect(Promise.race([corrected, wait(2000).then(() => 'not told')])).resolves.toBe(3);
  expect(reader.pages).toBe(3);
  await expect(reader.draw(4, 1)).rejects.toThrow();
  await reader.draw(3, 1);
  reader.destroy();
});
