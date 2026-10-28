// GRS-251 first page: the reviewed reader and the real pinned pdf.js open a synthetic original through a fetch double that
// logs every request. Each request to the original route costs a round trip before its first byte, so the reader must not
// chain them: a file up to 512 KiB is one plain GET, and a larger one starts its tail (where a file that is not linearized
// keeps its cross-reference table) together with the stream, not after the stream's headers.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { DOMMatrix, ImageData, Path2D, createCanvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';

const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';
/** A three-page PDF that is not linearized: pages first, `filler` bytes of content in the middle, the xref table last. */
function pdf(filler: number) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...[6, 6, 7].map((c) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${c} 0 R >>`),
    '<< /Length 15 >>\nstream\n0 0 20 20 re f\nendstream', `<< /Length ${filler} >>\nstream\n${' '.repeat(filler)}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

type Logged = { range: string | null; at: number };
let bytes = new Uint8Array(), log: Logged[] = [], inFlightAtFirstAnswer: Logged[] | null = null, refuseRanges = false, t0 = 0;
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
    const part = bytes.slice(Number(a), Number(b) + 1);
    return new Response(part, { status: 206, headers: { ...common, 'content-length': String(part.byteLength), 'content-range': `bytes ${a}-${Number(a) + part.byteLength - 1}/${bytes.byteLength}` } });
  }
  const whole = bytes;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    await wait(10);
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
beforeEach(() => { log = []; inFlightAtFirstAnswer = null; refuseRanges = false; t0 = performance.now(); });
const open = (size: number) => (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<{ pages: number; draw(n: number, s: number): Promise<void>; destroy(): void }> } } })
  .window.clearcasePdfReader.open({ src: SRC, size, canvas: createCanvas(100, 100), signal: new AbortController().signal });

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
