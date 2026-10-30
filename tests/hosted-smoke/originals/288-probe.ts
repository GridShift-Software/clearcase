// GRS-288 probe, not a test: the reviewed reader and the real pinned pdf.js worker this checkout serves open a synthetic
// page tree (288-page-tree.ts) through a range route with a stated latency model, then report the ranges, bytes and model
// time of each step. A model, never live speed evidence.
//   bun tests/hosted-smoke/originals/288-probe.ts --shape flat --pages 1200 --gap 204800 --jump 1000
// Latency model: every request waits `rtt` ms for its first byte, then its body crosses one shared downlink of `mbps`
// Mbit/s in the order the bodies are ready. Waits run `scale` times faster than the model; times are reported in model ms.
// `--ablate eager|check` removes, in this probe's copy of the worker only, the upstream eager fetch of every top-level kid
// or the deferred last-page check, to attribute their traffic.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DOMMatrix, ImageData, Path2D, createCanvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';
import { pageTree, type Shape } from './288-page-tree.ts';

const { values: o } = parseArgs({ options: {
  shape: { type: 'string', default: 'flat' }, pages: { type: 'string', default: '1200' }, gap: { type: 'string', default: String(200 * 1024) },
  descending: { type: 'boolean', default: false }, count: { type: 'string' }, rtt: { type: 'string', default: '280' }, mbps: { type: 'string', default: '7.3' },
  scale: { type: 'string', default: '10' }, idle: { type: 'string', default: '20000' }, turn: { type: 'string', default: '4' }, jump: { type: 'string', default: '1000' },
  early: { type: 'boolean', default: false }, ablate: { type: 'string' }, timeout: { type: 'string', default: '600000' },
} });
const rtt = Number(o.rtt), perMs = Number(o.mbps) * 1e6 / 8 / 1000, scale = Number(o.scale);
const { bytes } = pageTree({ pages: Number(o.pages), gap: Number(o.gap), shape: o.shape as Shape, descending: o.descending, count: o.count });
const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';

const t0 = performance.now();
const now = () => (performance.now() - t0) * scale;
const sleep = (model: number) => new Promise((r) => setTimeout(r, Math.max(0, model / scale)));
type Req = { begin: number; end: number; issued: number; done: number | null; phase: string };
const log: Req[] = [];
let phase = 'open', linkFree = 0;
async function original(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (String(input) !== SRC) throw new Error(`unexpected fetch ${String(input)}`);
  const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range') ?? '') ?? [];
  if (a === undefined) throw new Error('probe serves ranges only');
  const begin = Number(a), end = Number(b) + 1, req: Req = { begin, end, issued: now(), done: null, phase };
  log.push(req);
  const ready = req.issued + rtt, start = Math.max(ready, linkFree);
  linkFree = start + (end - begin) / perMs;
  await sleep(linkFree - now());
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  req.done = now();
  return new Response(bytes.slice(begin, end), { status: 206, headers: { 'content-range': `bytes ${begin}-${end - 1}/${bytes.byteLength}` } });
}

const assets = generatePdfAssets();
const worker = join(assets.dir, 'pdf-viewer-worker.mjs');
const cuts: Record<string, string> = {
  eager: 'n===this.toplevelPagesDict&&a instanceof Ref&&!o.has(a)&&o.put(a,s.fetchAsync(a))',
  check: 'clearcasePdfManager.deferredLastPageCheck?.()',
};
if (o.ablate) {
  const text = readFileSync(worker, 'utf8'), cut = cuts[o.ablate];
  if (!cut || text.split(cut).length !== 2) throw new Error(`ablation ${o.ablate} does not match this worker exactly once`);
  writeFileSync(worker, text.replace(cut, '0'));
}
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, fetch: original, window: Object.assign(new EventTarget(), {
  requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
}) });
await import(/* @vite-ignore */ join(assets.dir, 'pdf-reader.mjs'));
type Reader = { pages: number; draw(n: number, s: number): Promise<void>; destroy(): void };
const reader = (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<Reader> } } }).window.clearcasePdfReader;

const steps: Record<string, unknown>[] = [];
let recounted: { pages: number; at: number } | null = null;
async function step(name: string, run: () => Promise<unknown>) {
  phase = name;
  const at = now(), from = log.length;
  const out = await Promise.race([run().then(() => 'ok', (e: Error) => `error: ${e.message}`), sleep(Number(o.timeout)).then(() => 'timeout')]);
  const mine = log.slice(from);
  steps.push({ step: name, result: out, modelMs: Math.round(now() - at), requests: mine.length, bytes: mine.reduce((n, r) => n + r.end - r.begin, 0) });
}
let r!: Reader;
try {
  await step('open', async () => { r = await reader.open({ src: SRC, size: bytes.byteLength, canvas: Object.assign(createCanvas(100, 100), { style: {} }), signal: new AbortController().signal, onPages: (pages: number) => { recounted = { pages, at: Math.round(now()) }; } }); });
  await step('page 1', () => r.draw(1, 1));
  if (!o.early) {
    await step(`idle ${o.idle} ms on page 1`, () => sleep(Number(o.idle)));
    await step(`turn to page ${o.turn}`, () => r.draw(Number(o.turn), 1));
  }
  await step(`jump to page ${o.jump}`, () => r.draw(Number(o.jump), 1));
} finally { r?.destroy(); assets.dispose(); }
const total = { requests: log.length, bytes: log.reduce((n, q) => n + q.end - q.begin, 0), undelivered: log.filter((q) => q.done === null).length };
console.log(JSON.stringify({ model: { rttMs: rtt, mbps: Number(o.mbps), scale }, file: { bytes: bytes.byteLength, pages: Number(o.pages), shape: o.shape, descending: o.descending, count: o.count ?? null },
  ablate: o.ablate ?? null, pages: r?.pages, recounted, steps, total }));
process.exit(0);
