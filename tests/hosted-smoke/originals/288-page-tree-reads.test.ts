// GRS-288: the reviewed reader and the real pinned pdf.js worker this checkout serves, over synthetic page trees whose page
// dictionaries are spread through the file (288-page-tree.ts). On staging, opening a 258 MB original asked for every
// top-level page dictionary at once (upstream getPageDict fetches each top-level kid on its first walk), and a jump to page
// 1000 waited behind those reads. Opening must read only the head and the tail; a walk to a requested page reads only
// the kids that can hold it, together; the deferred last-page walk reads one range at a time; /Count is still checked.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { DOMMatrix, ImageData, Path2D, createCanvas, type Canvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';
import { pageTree } from './288-page-tree.ts';

const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';
const CHUNK = 2 ** 18, HEAD = 2 * CHUNK, TAIL = 2 ** 20, ROUND_TRIP = 40, GAP = CHUNK;
type Read = { begin: number; end: number; at: number; done: number };
let bytes = new Uint8Array(), log: Read[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function original(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (String(input) !== SRC) throw new Error(`unexpected fetch ${String(input)}`);
  const range = new Headers(init.headers).get('range');
  const [, a, b] = range ? /^bytes=(\d+)-(\d+)$/.exec(range)! : ['', '0', String(bytes.byteLength - 1)];
  const read = { begin: Number(a), end: Number(b) + 1, at: performance.now(), done: Infinity };
  log.push(read);
  await wait(ROUND_TRIP);
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  read.done = performance.now();
  return new Response(bytes.slice(read.begin, read.end), range
    ? { status: 206, headers: { 'content-range': `bytes ${a}-${read.end - 1}/${bytes.byteLength}` } }
    : { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
}
/** The most reads in flight at once among `reads`. */
const concurrency = (reads: Read[]) => Math.max(0, ...reads.map((r) => reads.filter((q) => q.at <= r.at && r.at < q.done).length));
type Reader = { pages: number; draw(n: number, s: number): Promise<void>; destroy(): void };
const open = (canvas: Canvas, onPages?: (n: number) => void) => (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<Reader> } } })
  .window.clearcasePdfReader.open({ src: SRC, size: bytes.byteLength, canvas: Object.assign(canvas, { style: {} }), signal: new AbortController().signal, onPages });
/** Dark pixels in page n's square, which 288-page-tree.ts draws at x = (n mod 9) * 10, y = 90..100 of the 100x100 canvas. */
function inkOf(canvas: Canvas, n: number) {
  const data = canvas.getContext('2d').getImageData(n % 9 * 10, 90, 10, 10).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128) dark++;
  return dark;
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
beforeEach(() => { log = []; });

it('opens a flat 64-page tree spread over 16 MiB with its head and tail alone, then reads page 5 by its own range', async () => {
  bytes = pageTree({ pages: 64, gap: GAP }).bytes;
  const size = bytes.byteLength, tail = Math.floor((size - TAIL) / CHUNK) * CHUNK;
  const canvas = createCanvas(100, 100), reader = await open(canvas);
  try {
    await reader.draw(1, 1);
    expect(log.slice(0, 2).map((r) => [r.begin, r.end])).toEqual([[0, HEAD], [tail, size]]);
    // The deferred last-page walk starts once page 1's operator list is done, with one read in flight.
    expect(log.length).toBeLessThanOrEqual(3);
    const before = log.length;
    await reader.draw(5, 1);
    expect(inkOf(canvas, 5)).toBe(100);
    expect(inkOf(canvas, 1)).toBe(0);
    // Pages 3 to 5 lie past the head, one stretch each; the deferred last-page walk may have one more read in flight.
    expect(log.length - before).toBeLessThanOrEqual(4);
  } finally { reader.destroy(); }
});

it('reads the kids that can hold a distant page together, not one after another, and draws that page', async () => {
  bytes = pageTree({ pages: 64, gap: GAP, shape: 'nested' }).bytes;
  const canvas = createCanvas(100, 100), reader = await open(canvas);
  try {
    await reader.draw(1, 1);
    const before = log.length, started = performance.now();
    await reader.draw(41, 1);
    expect(inkOf(canvas, 41)).toBe(100);
    const jump = log.slice(before);
    // Pages 3 to 41 each sit in their own stretch: one round trip with all of them in flight, not 39 in a row.
    expect(concurrency(jump)).toBeGreaterThanOrEqual(30);
    expect(performance.now() - started).toBeLessThan(20 * ROUND_TRIP);
    // Nothing past page 41 is read for it.
    expect(jump.filter((r) => r.begin >= HEAD + 41 * GAP).length).toBeLessThanOrEqual(1);
  } finally { reader.destroy(); }
});

it('walks to the last page one read at a time after page 1, and still corrects a /Count of 80 over 64 pages', async () => {
  bytes = pageTree({ pages: 64, gap: GAP, count: '80' }).bytes;
  let told: (n: number) => void;
  const corrected = new Promise<number>((resolve) => { told = resolve; });
  const canvas = createCanvas(100, 100), reader = await open(canvas, (n) => told(n));
  try {
    expect(reader.pages).toBe(80);
    await reader.draw(1, 1);
    const before = log.length;
    await expect(Promise.race([corrected, wait(200 * ROUND_TRIP).then(() => 'not told')])).resolves.toBe(64);
    expect(reader.pages).toBe(64);
    expect(concurrency(log.slice(before))).toBe(1);
    await expect(reader.draw(65, 1)).rejects.toThrow();
    await reader.draw(64, 1);
    expect(inkOf(canvas, 64)).toBe(100);
  } finally { reader.destroy(); }
});

it('keeps an understated /Count of 40 over 64 pages, as upstream pdf.js does', async () => {
  bytes = pageTree({ pages: 64, gap: GAP, count: '40' }).bytes;
  let told: number | null = null;
  const canvas = createCanvas(100, 100), reader = await open(canvas, (n) => { told = n; });
  try {
    await reader.draw(1, 1);
    await reader.draw(40, 1);
    expect(inkOf(canvas, 40)).toBe(100);
    await wait(60 * ROUND_TRIP);
    expect([reader.pages, told]).toEqual([40, null]);
    await expect(reader.draw(41, 1)).rejects.toThrow();
  } finally { reader.destroy(); }
});

/** Four valid pages in one nested subtree, followed by a sibling whose array never ends. */
function malformedSibling(): Uint8Array {
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [11 0 R] /Count 4 >>',
    11: '<< /Type /Pages /Parent 2 0 R /Kids [13 0 R 12 0 R] /Count 4 >>',
    12: '<< /Type /Pages /Kids [',
    13: '<< /Type /Pages /Parent 11 0 R /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>',
  };
  for (let page = 1; page <= 4; page++) {
    objects[page + 2] = `<< /Type /Page /Parent 13 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${page + 6} 0 R >>`;
    const ops = `${page * 10} 0 10 10 re f`;
    objects[page + 6] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  let text = '%PDF-1.4\n% SYNTHETIC ONLY GRS-288\n';
  const offsets = [0];
  for (let n = 1; n <= 13; n++) {
    offsets[n] = text.length;
    text += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = text.length;
  text += 'xref\n0 14\n0000000000 65535 f \n';
  for (let n = 1; n <= 13; n++) text += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  return new TextEncoder().encode(text + `trailer\n<< /Size 14 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

it('observes an unused malformed nested sibling rejection while all requested pages still draw', async () => {
  bytes = malformedSibling();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  const canvas = createCanvas(100, 100);
  let reader: Reader | undefined;
  try {
    reader = await open(canvas);
    for (let page = 1; page <= 4; page++) {
      await reader.draw(page, 1);
      expect(inkOf(canvas, page)).toBe(100);
    }
    await wait(ROUND_TRIP);
    expect(unhandled).toEqual([]);
  } finally {
    reader?.destroy();
    process.off('unhandledRejection', record);
  }
});
