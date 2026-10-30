// GRS-288 probe, not a test: the reviewed reader and the real pinned pdf.js worker this checkout serves open a synthetic
// page tree (288-page-tree.ts) through a range route with a stated latency model, then report the ranges, bytes and model
// time of each step. A model, never live speed evidence.
//   bun tests/hosted-smoke/originals/288-probe.ts --shape flat --pages 300 --image 400 --turn 5 --jump 250
// Latency model: every request waits `rtt` ms for its first byte, then its body crosses one shared downlink of `mbps`
// Mbit/s in the order the bodies are ready. With `--serve serial` the route answers one request at a time instead: each
// waits for the one before it, then takes `rtt` ms plus its body at `mbps`. Waits run `scale` times faster than the
// model; times are reported in model ms, which include the probe's own CPU time multiplied by `scale` (cpuMs, real).
// Each step's newly read bytes are split into page-tree and xref metadata, the content of the pages the probe asked for
// (their streams and images) and other pages' content read only because it shared a range with something needed.
// `--ablate eager|check` removes, in this probe's copy of the worker only, the upstream eager fetch of every top-level kid
// or the deferred last-page check; `--chunk BYTES` sets only pdf.js's rangeChunkSize in this probe's copy of the reader.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DOMMatrix, ImageData, Path2D, createCanvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';
import { pageTree, type Shape } from './288-page-tree.ts';

const { values: o } = parseArgs({ options: {
  shape: { type: 'string', default: 'flat' }, pages: { type: 'string', default: '1200' }, gap: { type: 'string', default: String(200 * 1024) },
  image: { type: 'string' }, pad: { type: 'string', default: '0' }, descending: { type: 'boolean', default: false }, count: { type: 'string' },
  serve: { type: 'string', default: 'parallel' }, rtt: { type: 'string', default: '280' }, mbps: { type: 'string', default: '7.3' }, scale: { type: 'string', default: '10' },
  idle: { type: 'string', default: '20000' }, turn: { type: 'string', default: '4' }, jump: { type: 'string', default: '1000' },
  early: { type: 'boolean', default: false }, trace: { type: 'boolean', default: false }, recount: { type: 'boolean', default: false }, ablate: { type: 'string' }, chunk: { type: 'string' },
  timeout: { type: 'string', default: '600000' },
} });
const rtt = Number(o.rtt), perMs = Number(o.mbps) * 1e6 / 8 / 1000, scale = Number(o.scale);
const tree = pageTree({ pages: Number(o.pages), gap: Number(o.gap), image: o.image ? Number(o.image) : undefined, shape: o.shape as Shape, descending: o.descending, count: o.count, pad: Number(o.pad) });
const { bytes } = tree;
const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';

const t0 = performance.now();
const now = () => (performance.now() - t0) * scale;
const sleep = (model: number) => new Promise((r) => setTimeout(r, Math.max(0, model / scale)));
type Req = { begin: number; end: number; issued: number; done: number | null };
const log: Req[] = [];
let linkFree = 0;
async function original(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (String(input) !== SRC) throw new Error(`unexpected fetch ${String(input)}`);
  const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range') ?? '') ?? [];
  if (a === undefined) throw new Error('probe serves ranges only');
  const begin = Number(a), end = Number(b) + 1, req: Req = { begin, end, issued: now(), done: null };
  log.push(req);
  if (o.serve === 'serial') linkFree = Math.max(req.issued, linkFree) + rtt + (end - begin) / perMs;
  else linkFree = Math.max(req.issued + rtt, linkFree) + (end - begin) / perMs;
  await sleep(linkFree - now());
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  req.done = now();
  return new Response(bytes.slice(begin, end), { status: 206, headers: { 'content-range': `bytes ${begin}-${end - 1}/${bytes.byteLength}` } });
}

/** Byte ranges already read, kept merged, so each step counts only bytes no earlier step brought. */
let seen: [number, number][] = [];
function fresh(ranges: [number, number][]) {
  const out: [number, number][] = [];
  for (const [b, e] of ranges.sort((x, y) => x[0] - y[0])) {
    let at = b;
    for (const [sb, se] of seen) { if (se <= at || sb >= e) continue; if (sb > at) out.push([at, sb]); at = Math.max(at, se); }
    if (at < e) out.push([at, e]);
    seen = [...seen, [b, e]].sort((x, y) => x[0] - y[0]).reduce<[number, number][]>((m, r) => {
      const last = m.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else m.push([r[0], r[1]]); return m;
    }, []);
  }
  return out;
}
const asked = new Set<number>();
function classify(ranges: [number, number][]) {
  const kinds = { meta: 0, asked: 0, collateral: 0 };
  for (const [b, e] of ranges) for (const r of tree.regions) {
    const n = Math.min(e, r.end) - Math.max(b, r.start);
    if (n <= 0) continue;
    if (r.kind === 'meta') kinds.meta += n; else if (asked.has(r.page! + 1)) kinds.asked += n; else kinds.collateral += n;
  }
  return kinds;
}

const assets = generatePdfAssets();
function cut(file: string, from: string, to: string) {
  const path = join(assets.dir, file), text = readFileSync(path, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`${file}: probe edit does not match exactly once`);
  writeFileSync(path, text.replace(from, to));
}
const ablations: Record<string, string> = {
  eager: 'n===this.toplevelPagesDict&&a instanceof Ref&&!o.has(a)&&o.put(a,s.fetchAsync(a))',
  check: 'clearcasePdfManager.deferredLastPageCheck?.()',
};
if (o.ablate) cut('pdf-viewer-worker.mjs', ablations[o.ablate] ?? '\0', '0');
if (o.chunk) cut('pdf-reader.mjs', 'rangeChunkSize: CHUNK,', `rangeChunkSize: ${Number(o.chunk)},`);
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, fetch: original, window: Object.assign(new EventTarget(), {
  requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
}) });
await import(/* @vite-ignore */ join(assets.dir, 'pdf-reader.mjs'));
type Reader = { pages: number; draw(n: number, s: number): Promise<void>; destroy(): void };
const reader = (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<Reader> } } }).window.clearcasePdfReader;

const steps: Record<string, unknown>[] = [];
let told!: (n: number) => void, recountAt: number | null = null;
const recounted = new Promise<number>((resolve) => { told = resolve; });
async function step(name: string, run: () => Promise<unknown>, page?: number) {
  if (page) asked.add(page);
  const at = now(), from = log.length, cpu = process.cpuUsage();
  const out = await Promise.race([run().then((v) => v === undefined ? 'ok' : `ok ${v}`, (e: Error) => `error: ${e.message}`), sleep(Number(o.timeout)).then(() => 'timeout')]);
  const { user, system } = process.cpuUsage(cpu), mine = log.slice(from);
  const wire = mine.reduce((n, r) => n + r.end - r.begin, 0), news = fresh(mine.map((r) => [r.begin, r.end]));
  steps.push({ step: name, result: out, modelMs: Math.round(now() - at), cpuMs: Math.round((user + system) / 1000), requests: mine.length, wire,
    distinct: news.reduce((n, [b, e]) => n + e - b, 0), ...classify(news),
    ...(o.trace ? { trace: mine.map((q) => [Math.round(q.issued - at), q.done === null ? null : Math.round(q.done - at), q.begin, q.end - q.begin]) } : {}) });
}
let r!: Reader;
const canvas = Object.assign(createCanvas(100, 100), { style: {} });
/** Draws page n and checks its square (288-page-tree.ts) is on the canvas, so a fast wrong draw is not a result. */
const drawn = (n: number) => () => r.draw(n, 1).then(() => {
  const data = canvas.getContext('2d').getImageData(n % 9 * 10, 90, 10, 10).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128) dark++;
  if (dark !== 100) throw new Error(`page ${n} square not drawn`);
});
try {
  await step('open', async () => { r = await reader.open({ src: SRC, size: bytes.byteLength, canvas, signal: new AbortController().signal, onPages: (n: number) => { recountAt ??= Math.round(now()); told(n); } }); });
  await step('page 1', drawn(1), 1);
  if (!o.early) {
    if (Number(o.idle)) await step(`idle ${o.idle} ms on page 1`, () => sleep(Number(o.idle)));
    await step(`turn to page ${o.turn}`, drawn(Number(o.turn)), Number(o.turn));
  }
  await step(`jump to page ${o.jump}`, drawn(Number(o.jump)), Number(o.jump));
  if (o.recount) await step('count correction', () => recounted);
} finally { r?.destroy(); assets.dispose(); }
const total = { requests: log.length, wire: log.reduce((n, q) => n + q.end - q.begin, 0), undelivered: log.filter((q) => q.done === null).length };
console.log(JSON.stringify({ model: { serve: o.serve, rttMs: rtt, mbps: Number(o.mbps), scale }, chunk: o.chunk ? Number(o.chunk) : 262144,
  file: { bytes: bytes.byteLength, pages: Number(o.pages), shape: o.shape, image: o.image ? Number(o.image) : null, pad: Number(o.pad), descending: o.descending, count: o.count ?? null },
  ablate: o.ablate ?? null, pages: r?.pages, recountAt, steps, total }));
process.exit(0);
