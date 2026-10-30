// GRS-281: the reviewed reader and the real pinned pdf.js, through a fetch double of the original route. On staging, a
// 258 MB original left open on page 1 streamed the whole file in the background, in the full viewer (a whole-file GET
// beside the ranges) and in the chronology pane (which passes no size, so pdf.js streamed it itself). The reader must read
// the head and the tail at once, then only the ranges a page asks for, and draw at the device's pixel ratio.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { DOMMatrix, ImageData, Path2D, createCanvas, type Canvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';

const SESSION = 'https://app.test/cases/case-a/originals/asset-1', SRC = `${SESSION}?t=synthetic`;
const CHUNK = 2 ** 18, HEAD = 2 * CHUNK, TAIL = 2 ** 20, ROUND_TRIP = 40;

type Built = { bytes: Uint8Array<ArrayBuffer>; offsets: number[] };
function build(objects: string[]): Built {
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return { bytes: new TextEncoder().encode(text), offsets };
}
const stream = (ops: string) => `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
/** Three 100x100 pages that are not linearized: pages 1 and 2 draw a square at the bottom left from the head of the file;
 *  page 3's square (top right) sits after `middle` bytes of filler and before `end` more, so it is in neither the head
 *  nor the tail; the xref table is last. */
function book(middle: number, end: number) {
  const page = (contents: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${contents} 0 R >>`;
  return build(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>', page(6), page(6), page(8),
    stream('0 0 20 20 re f'), stream(' '.repeat(middle)), stream('60 60 30 30 re f'), stream(' '.repeat(end))]);
}

let bytes = new Uint8Array(), log: { url: string; range: string | null; status: number }[] = [], served = 0;
let refuseRanges = false, expired = false;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The original route: a ticketed URL answers 404 once the ticket has expired, the ticketless one authorizes through the
 *  session. Every answer waits a round trip; a whole-file body arrives in 64 KiB pieces. `served` counts the bytes sent. */
async function original(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (url !== SRC && url !== SESSION) throw new Error(`unexpected fetch ${url}`);
  const range = new Headers(init.headers).get('range');
  const entry = { url, range, status: 0 };
  log.push(entry);
  await wait(ROUND_TRIP);
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const common = { 'accept-ranges': 'bytes', 'content-type': 'application/pdf', etag: '"e"' };
  if (expired && url === SRC) return new Response(null, { status: entry.status = 404 });
  if (range) {
    if (refuseRanges) return new Response(null, { status: entry.status = 412, headers: common });
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const part = bytes.slice(Number(a), Number(b) + 1);
    served += part.byteLength;
    return new Response(part, { status: entry.status = 206, headers: { ...common, 'content-length': String(part.byteLength), 'content-range': `bytes ${a}-${Number(a) + part.byteLength - 1}/${bytes.byteLength}` } });
  }
  const whole = bytes;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    await wait(10);
    if (at >= whole.byteLength) return c.close();
    const piece = whole.slice(at, at += 65536);
    served += piece.byteLength;
    c.enqueue(piece);
  } });
  return new Response(body, { status: entry.status = 200, headers: { ...common, 'content-length': String(whole.byteLength) } });
}

type Reader = { pages: number; draw(n: number, s: number, fitWidth?: number): Promise<void>; destroy(): void };
type Element = Canvas & { style: Record<string, string> };
const canvasElement = () => Object.assign(createCanvas(1, 1), { style: {} }) as Element;
const global = globalThis as unknown as { window: { devicePixelRatio?: number; clearcasePdfReader: { open(a: object): Promise<Reader> } } };
const open = (size: number | undefined, canvas = canvasElement(), signal = new AbortController().signal) =>
  global.window.clearcasePdfReader.open({ src: SRC, size, canvas, signal });
/** Pixels darker than light grey inside the box [x0, x1) x [y0, y1) of the backing store. */
function ink(canvas: Canvas, [x0, y0, x1, y1] = [0, 0, canvas.width, canvas.height]) {
  const data = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128 && data[i + 1]! < 128 && data[i + 2]! < 128) dark++;
  return dark;
}
const span = (range: string) => { const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!; return [Number(a), Number(b)] as const; };

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
beforeEach(() => { log = []; served = 0; refuseRanges = false; expired = false; global.window.devicePixelRatio = undefined; });

it('reads only the head and the tail of a 6 MiB original while page 1 stays open, then page 3 by its own range', async () => {
  const { bytes: file, offsets } = book(4 * 2 ** 20, 2 * 2 ** 20);
  bytes = file;
  const size = bytes.byteLength, tail = Math.floor((size - TAIL) / CHUNK) * CHUNK;
  const canvas = canvasElement(), reader = await open(size, canvas);
  try {
    await reader.draw(1, 1);
    // Idle on page 1 for about 25 round trips: long enough for a background stream to bring most of the file.
    await wait(1000);
    expect(log.map((l) => l.range)).toEqual([`bytes=0-${HEAD - 1}`, `bytes=${tail}-${size - 1}`]);
    expect(served).toBe(HEAD + size - tail);
    expect(reader.pages).toBe(3);
    await reader.draw(3, 1);
    const later = log.slice(2);
    expect(later).toHaveLength(1);
    const [a, b] = span(later[0]!.range!);
    expect(a).toBeLessThanOrEqual(offsets[7]!);
    expect(b).toBeGreaterThan(offsets[7]!);
    expect(b - a + 1).toBeLessThanOrEqual(2 * CHUNK);
    // Page 3's square is at the top right; nothing of page 1's is left at the bottom left.
    expect(ink(canvas, [60, 10, 90, 40])).toBe(900);
    expect(ink(canvas, [0, 80, 20, 100])).toBe(0);
  } finally { reader.destroy(); }
});

it('reads a later page through the session once the asset ticket has expired', async () => {
  bytes = book(4 * 2 ** 20, 2 * 2 ** 20).bytes;
  const reader = await open(bytes.byteLength);
  try {
    await reader.draw(1, 1);
    expired = true;
    await reader.draw(3, 1);
    expect(log.slice(2).map(({ url, status }) => [url, status])).toEqual([[SRC, 404], [SESSION, 206]]);
    // The session URL is kept: nothing asks the expired ticket again.
    await reader.draw(2, 1);
    expect(log.slice(4).every((l) => l.url === SESSION)).toBe(true);
  } finally { reader.destroy(); }
});

it('reads only the head and the tail when the page gives no size, as the chronology pane does', async () => {
  bytes = book(4 * 2 ** 20, 2 * 2 ** 20).bytes;
  const size = bytes.byteLength, tail = Math.floor((size - TAIL) / CHUNK) * CHUNK;
  const reader = await open(undefined);
  try {
    await reader.draw(1, 1);
    await wait(1000);
    expect(log.map((l) => l.range)).toEqual([`bytes=0-${HEAD - 1}`, `bytes=${tail}-${size - 1}`]);
    expect(served).toBe(HEAD + size - tail);
    expect(reader.pages).toBe(3);
  } finally { reader.destroy(); }
});

it('opens a 300 KiB original of unknown size with its one head range', async () => {
  bytes = book(300 * 1024, 0).bytes;
  const reader = await open(undefined);
  try {
    await reader.draw(3, 1);
    expect(log.map((l) => l.range)).toEqual([`bytes=0-${HEAD - 1}`]);
  } finally { reader.destroy(); }
});

it('ends the open of an original of unknown size with an error when its first range is refused', async () => {
  bytes = book(4 * 2 ** 20, 0).bytes; refuseRanges = true;
  await expect(open(undefined)).rejects.toThrow();
});

it('stops an open of unknown size whose signal aborts while its head is in flight', async () => {
  bytes = book(4 * 2 ** 20, 0).bytes;
  const controller = new AbortController(), opening = open(undefined, canvasElement(), controller.signal);
  await wait(ROUND_TRIP / 2);
  controller.abort();
  const settled = opening.then(() => 'opened', () => 'rejected');
  await expect(Promise.race([settled, wait(1000).then(() => 'pending')])).resolves.toBe('rejected');
  await wait(4 * ROUND_TRIP);
  expect(log.map((l) => l.range)).toEqual([`bytes=0-${HEAD - 1}`]);
});

it('draws at the device pixel ratio into a canvas that keeps its CSS size', async () => {
  bytes = book(1024, 0).bytes;
  global.window.devicePixelRatio = 2;
  const canvas = canvasElement(), reader = await open(bytes.byteLength, canvas);
  try {
    await reader.draw(1, 1);
    expect([canvas.width, canvas.height]).toEqual([200, 200]);
    expect(canvas.style).toMatchObject({ width: '100px', height: '100px' });
    // The 20 x 20 square covers 40 x 40 device pixels: the drawing is scaled into the backing store, not shrunk into a corner.
    expect(ink(canvas, [0, 160, 40, 200])).toBe(1600);
    expect(ink(canvas)).toBe(1600);
    // A phone pane's fit width stays the CSS width.
    await reader.draw(1, 1.2, 60);
    expect(canvas.style).toMatchObject({ width: '60px', height: '60px' });
    expect([canvas.width, canvas.height]).toEqual([120, 120]);
  } finally { reader.destroy(); }
});

it('caps the backing store of a zoomed page at the phone canvas budget, never below its CSS size', async () => {
  bytes = book(1024, 0).bytes;
  global.window.devicePixelRatio = 3;
  const canvas = canvasElement(), reader = await open(bytes.byteLength, canvas);
  try {
    await reader.draw(1, 20);
    expect(canvas.style).toMatchObject({ width: '2000px', height: '2000px' });
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(5_242_880);
    expect(canvas.width).toBeGreaterThan(2000);
    await reader.draw(1, 30);
    expect(canvas.style).toMatchObject({ width: '3000px', height: '3000px' });
    expect([canvas.width, canvas.height]).toEqual([3000, 3000]);
  } finally { reader.destroy(); }
});
