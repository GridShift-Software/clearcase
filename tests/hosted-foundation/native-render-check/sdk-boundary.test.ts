// SDK BOUNDARY DOUBLES ONLY. No browser, provider, workerd or PDF rendering is run by this file.
// An artificial transcript exercises orchestration/negative gates; it is NEVER renderer acceptance.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserWorker, HTTPRequest, Page } from '@cloudflare/puppeteer';
import type { CloudD1, CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { NATIVE_SDK_BUILD_SCHEMA, NATIVE_SDK_INPUT_PINS, NATIVE_SDK_WORKER_OUTPUTS } from '../../../scripts/native-render-sdk-build.ts';
import { NATIVE_SDK_BUFFER_SOURCE, NATIVE_SDK_DEBUG_SOURCE, NATIVE_SDK_HOST_SYMBOLS } from '../../../src/lib/viewer/hosted/sdk-build-contract.ts';
import { createNativePreviewRenderChecker, NATIVE_PDF_RENDER_CEILINGS, type NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';

const sdk = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: sdk.launch } }));
const root = mkdtempSync(join(tmpdir(), 'clearcase-native-pdf-unit-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bytes = new TextEncoder().encode('%PDF-1.7\nSYNTHETIC SDK BOUNDARY INPUT; NOT A RENDERABLE PDF.');
const sha256 = await crypto.subtle.digest('SHA-256', bytes).then(b => Buffer.from(b).toString('hex'));
const clientId = id('client', 'client-a'), caseId = id('case', 'case-a1');
const input = () => ({ clientId, caseId, candidateId: 'candidate-a1', resultsVersion: resultsVersion('sha256:' + 'a'.repeat(64)), assetId: 'preview-a1', mediaType: 'application/pdf', bytes: bytes.slice(), sha256 });
const day = 20_000 * 86_400_000;
let clock = day + 10_000;
const databases: DatabaseSync[] = [];
afterAll(() => databases.forEach(db => db.close()));

/** Actual SQLite migration/trigger logic, with a deliberately labelled in-process D1 API boundary double. */
function rawDatabase() {
 const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
 sqlite.exec(readFileSync('src/lib/viewer/hosted/migrations/0001_preview_render_work.sql', 'utf8'));
 type Statement = CloudD1Statement & { sql: string; values: (string | number | null)[] };
 const primary: CloudD1 = {
  prepare(sql) {
   const s: Statement = {
    sql, values: [], bind(...values) { s.values = values; return s; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...s.values) as T[] }; },
    async first<T>() { return (sqlite.prepare(sql).get(...s.values) ?? null) as T | null; },
    async run() { return sqlite.prepare(sql).run(...s.values); },
   }; return s;
  },
  async batch(statements) {
   sqlite.exec('BEGIN IMMEDIATE');
   try {
    const outputs = statements.map(s => { const { sql, values } = s as Statement; return { success: true, results: sqlite.prepare(sql).all(...values) }; });
    sqlite.exec('COMMIT'); return outputs;
   } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
 };
 return { sqlite, primary, withSession: vi.fn((constraint: 'first-primary') => { expect(constraint).toBe('first-primary'); return primary; }) };
}

/** Inert SDK boundary. Captures routes and returns fabricated canvas metadata without executing page code. */
function sdkBoundary() {
 const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
 const served = new Map<string, { body?: string | Uint8Array; headers?: Record<string, string> }>();
 let pendingRequest: Promise<unknown> = Promise.resolve();
 const mainFrame = {};
 const request = async (url: string, type = 'script', method = 'GET') => {
  let finish!: () => void;
  pendingRequest = new Promise<void>(resolve => { finish = resolve; });
  const req = {
   url: () => url, method: () => method, resourceType: () => type,
   isNavigationRequest: () => type === 'document', frame: () => mainFrame,
   respond: vi.fn(async (response: { body?: string | Uint8Array; headers?: Record<string, string> }) => { served.set(new URL(url).pathname, response); finish(); }),
   abort: vi.fn(async () => { finish(); }),
  };
  for (const f of listeners.get('request') ?? []) f(req as unknown as HTTPRequest);
  await pendingRequest;
  return req;
 };
 const page = {
  setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
  setBypassServiceWorker: vi.fn(async () => {}), setCacheEnabled: vi.fn(async () => {}), setRequestInterception: vi.fn(async () => {}),
  mainFrame: () => mainFrame,
  on(name: string, f: (...args: unknown[]) => unknown) { listeners.set(name, [...listeners.get(name) ?? [], f]); return page; },
  goto: vi.fn(async (url: string) => {
   await request(url, 'document');
   await request('https://app.example/__clearcase_native_pdf__/inspector.mjs');
   await request('https://app.example/pdfjs/pdf.min.mjs');
  }),
  evaluate: vi.fn(async (_fn: unknown, args: { binding: string; sha256: string; size: number }): Promise<unknown> => {
   await request('https://app.example/__clearcase_native_pdf__/input.pdf', 'fetch');
   await request('https://app.example/pdfjs/pdf.worker.min.mjs', 'fetch');
   return { ...args, pdfjsVersion: '6.4.299', totalPages: 2, pages: [1, 2].map(number => ({ number, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'c'.repeat(64) })) };
  }),
  close: vi.fn(async () => {}),
 };
 // Preserve the original close spy/assertions as an inert root-CDP close-command observation.
 // This double does NOT execute SDK Browser.close(); security-regressions tests that real faulty callback separately.
 const closedListeners = new Set<() => void>();
 let connected = true;
 const browser = {
  newPage: vi.fn(async () => page as unknown as Page), close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  get connected() { return connected; },
  on(_name: string, listener: () => void) { closedListeners.add(listener); },
  off(_name: string, listener: () => void) { closedListeners.delete(listener); },
  target: () => ({ createCDPSession: async () => ({ connection: () => ({
   send: async () => { await browser.close(); connected = false; for (const listener of closedListeners) listener(); return {}; },
  }) }) }),
 };
 return { page, browser, request, served, emit: (name: string, ...args: unknown[]) => { for (const fn of listeners.get(name) ?? []) fn(...args); } };
}
function options(db = rawDatabase()): NativePreviewRenderOptions {
 return {
  db, clientId, browser: { fetch: vi.fn(async () => { throw Error('inert BROWSER double: no provider call'); }) } as BrowserWorker,
  assets: { fetch: vi.fn(async (request: Request) => new Response(readFileSync(join(root, new URL(request.url).pathname)))) },
  appOrigin: 'https://app.example', pins: structuredClone(pins), budget: { ...NATIVE_PDF_RENDER_CEILINGS }, now: () => new Date(clock),
 };
}
beforeEach(() => { sdk.launch.mockReset(); clock = day + 10_000; });

describe('native PDF SDK boundary orchestration (NOT renderer acceptance)', () => {
 it('uses official launch only after committed primary reservation; pins static bytes and closes', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(), o = options(db);
  sdk.launch.mockImplementation(async () => {
   const row = db.sqlite.prepare('SELECT * FROM npr_reservations').get();
   expect(row).toMatchObject({ client_id: clientId, case_id: caseId, input_sha256: sha256, input_size: bytes.length, results_version: 'sha256:' + 'a'.repeat(64) });
   return boundary.browser;
  });
  const checker = (await createNativePreviewRenderChecker(o))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered', pages: 2 }); // fabricated SDK transcript only
  expect(sdk.launch).toHaveBeenCalledWith(expect.anything(), { keep_alive: 60_000, recording: false, guardrails: { allowedDomains: [] } });
  expect(db.withSession).toHaveBeenCalledWith('first-primary');
  expect(boundary.browser.close).toHaveBeenCalledOnce(); expect(boundary.page.close).toHaveBeenCalledWith({ runBeforeUnload: false });
  expect(boundary.browser.disconnect).toHaveBeenCalledOnce();
  expect(o.assets!.fetch).toHaveBeenCalledTimes(2);
  expect(boundary.served.get('/__clearcase_native_pdf__/input.pdf')!.body).toEqual(bytes);
  const source = String(boundary.served.get('/__clearcase_native_pdf__/inspector.mjs')!.body);
  for (const required of ['new Worker(', 'await rendering.promise', 'getImageData(', 'worker?.terminate()', 'isEvalSupported: false', 'enableScripting: false', 'enableXfa: false', 'stopAtErrors: true']) expect(source).toContain(required);
  expect(source).not.toContain('innerHTML'); expect(source).not.toContain(sha256); expect(source).not.toContain('candidate-a1');
  expect(boundary.served.get('/__clearcase_native_pdf__/inspect')!.headers!['content-security-policy']).not.toContain('unsafe-eval');
 });

 it.each(['db', 'browser', 'assets', 'pins', 'budget'] as const)('is unavailable without %s', async key => {
  const o = options(); o[key] = null;
  expect(await createNativePreviewRenderChecker(o)).toBeNull(); expect(sdk.launch).not.toHaveBeenCalled();
 });
 it('requires every explicit finite positive integer budget and enforces conservative ceilings', async () => {
  for (const key of Object.keys(NATIVE_PDF_RENDER_CEILINGS) as (keyof typeof NATIVE_PDF_RENDER_CEILINGS)[]) {
   for (const bad of [undefined, null, Infinity, NaN, 0, -1, 1.5, NATIVE_PDF_RENDER_CEILINGS[key] + 1]) {
    const o = options(); Object.assign(o.budget!, { [key]: bad });
    expect(await createNativePreviewRenderChecker(o)).toBeNull();
   }
  }
 });
 it('rejects noncanonical origins, bad pin manifest and mutable configuration substitution', async () => {
  for (const appOrigin of ['http://app.example', 'https://app.example/', 'https://x:secret@app.example', 'https://app.example/?x=1']) expect(await createNativePreviewRenderChecker({ ...options(), appOrigin })).toBeNull();
  const broken = options(); broken.pins!.files = broken.pins!.files.slice(1);
  expect(await createNativePreviewRenderChecker(broken)).toBeNull();
  const corrupt = options(); corrupt.pins!.files = corrupt.pins!.files.map((f, i) => i === 0 ? { ...f, bytes: f.bytes + 1 } : f);
  expect(await createNativePreviewRenderChecker(corrupt)).toBeNull();
  const o = options(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(o))!;
  o.budget!.maxFileBytes = 1; o.clientId = id('client', 'client-b'); o.assets = { fetch: async () => { throw Error('replacement'); } };
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' }); // original captured config, fake transcript
 });
 it('honestly refuses other media, hash mismatch, invalid PDF header, wrong client and oversize before admission', async () => {
  const db = rawDatabase(), o = options(db), checker = (await createNativePreviewRenderChecker(o))!;
  for (const changed of [ { mediaType: 'image/png' }, { sha256: 'b'.repeat(64) }, { clientId: id('client', 'client-b') }, { bytes: new Uint8Array(4_000_001) }, { assetId: 'https://attacker.example' } ]) {
   expect(await checker.verify({ ...input(), ...changed })).toMatchObject({ state: 'failed' });
  }
  const invalid = new TextEncoder().encode('not pdf');
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', invalid)).toString('hex');
  expect(await checker.verify({ ...input(), bytes: invalid, sha256: digest })).toMatchObject({ state: 'failed' });
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_reservations').get()!.n).toBe(0); expect(sdk.launch).not.toHaveBeenCalled();
 });
 it('copies input identities and bytes before the first await', async () => {
  const boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options()))!;
  const value = input(), verification = checker.verify(value);
  value.bytes.fill(0); value.caseId = id('case', 'case-a2'); value.assetId = 'replacement'; value.sha256 = 'd'.repeat(64);
  expect(await verification).toMatchObject({ state: 'rendered' });
  expect(boundary.served.get('/__clearcase_native_pdf__/input.pdf')!.body).toEqual(bytes);
 });
 it.each(['network', 'static', 'static-size', 'redirect', 'missing', 'sdk-error', 'pageerror', 'requestfailed', 'cleanup'])('fails closed on %s without logging errors or protected bytes', async mode => {
  const db = rawDatabase(), boundary = sdkBoundary(), o = options(db);
  const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
  try {
   sdk.launch.mockResolvedValue(boundary.browser);
   if (mode === 'network') boundary.page.goto.mockImplementationOnce(async () => { expect((await boundary.request('https://attacker.example/secret', 'fetch')).abort).toHaveBeenCalledOnce(); });
   if (mode === 'static') o.assets = { fetch: async () => new Response('corrupted') };
   if (mode === 'static-size') o.assets = { fetch: async request => new Response(Buffer.concat([readFileSync(join(root, new URL(request.url).pathname)), Buffer.from('x')])) };
   if (mode === 'redirect') o.assets = { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }) };
   if (mode === 'missing') o.assets = { fetch: async () => new Response(null, { status: 404 }) };
   if (mode === 'sdk-error') sdk.launch.mockRejectedValue(Error('SYNTHETIC_SECRET_CANARY'));
   if (['pageerror', 'requestfailed'].includes(mode)) boundary.page.goto.mockImplementationOnce(async () => { boundary.emit(mode, Error('SYNTHETIC_SECRET_CANARY')); });
   if (mode === 'cleanup') boundary.page.close.mockRejectedValueOnce(Error('SYNTHETIC_SECRET_CANARY'));
   const checker = (await createNativePreviewRenderChecker(o))!;
   expect(await checker.verify(input())).toMatchObject({ state: 'failed' });
   expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
   for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { logs.forEach(log => log.mockRestore()); }
 });
 it.each(['POST', 'query', 'same-origin-private', 'reader', 'other-origin', 'unknown'])('never continues a nonrequired request: %s', async mode => {
  const boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const urls: Record<string, string> = { POST: '/pdfjs/pdf.min.mjs', query: '/pdfjs/pdf.min.mjs?x=1', 'same-origin-private': '/api/private', reader: '/pdfjs/pdf-reader.mjs', 'other-origin': 'https://thirdparty.example/pdfjs/pdf.min.mjs', unknown: '/pdfjs/unknown.mjs' };
  boundary.page.goto.mockImplementationOnce(async () => {
   const r = await boundary.request(new URL(urls[mode]!, 'https://app.example').href, 'fetch', mode === 'POST' ? 'POST' : 'GET');
   expect(r.abort).toHaveBeenCalledOnce(); expect(r.respond).not.toHaveBeenCalled();
  });
  const checker = (await createNativePreviewRenderChecker(options()))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'failed' }); expect(boundary.page.close).toHaveBeenCalledOnce();
 });
 it('checks total pages, every pixel readback, bound identities and renderer version rather than a rendered flag', async () => {
  const good = { binding: '', sha256, size: bytes.length, pdfjsVersion: '6.4.299', totalPages: 2, pages: [1, 2].map(number => ({ number, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'a'.repeat(64) })) };
  const mutations = [
   { state: 'rendered' }, { ...good, totalPages: 3 }, { ...good, totalPages: 0 }, { ...good, pages: [] },
   { ...good, size: 0 }, { ...good, sha256: 'e'.repeat(64) }, { ...good, pdfjsVersion: 'other' },
   { ...good, pages: [good.pages[1], good.pages[0]] }, { ...good, pages: [{ ...good.pages[0], pixelBytes: 0 }, good.pages[1]] },
   { ...good, pages: [{ ...good.pages[0], pixelSha256: '' }, good.pages[1]] },
   { ...good, pages: [{ ...good.pages[0], width: Infinity }, good.pages[1]] },
   { ...good, pages: [1, 2].map(number => ({ number, width: 4096, height: 4096, pixelBytes: 4096 * 4096 * 4, pixelSha256: 'c'.repeat(64) })) },
  ];
  for (const mutated of mutations) {
   const boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
   boundary.page.evaluate.mockImplementationOnce(async (_fn, args) => ({ ...mutated, binding: args.binding }));
   const checker = (await createNativePreviewRenderChecker(options()))!;
   expect(await checker.verify(input())).toMatchObject({ state: 'failed' });
  }
  const boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  boundary.page.evaluate.mockResolvedValueOnce(good); // wrong exact-file binding
  expect(await (await createNativePreviewRenderChecker(options()))!.verify(input())).toMatchObject({ state: 'failed' });
 });
 it('reuses only immutable exact-file success after fresh hashing, across readiness/signoff/publish and factories', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(), o = options(db); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(o))!;
  const first = await checker.verify(input());
  expect(first).toMatchObject({ state: 'rendered', pages: 2, rendererVersion: expect.stringMatching(/^clearcase\.native-pdf\/2;sha256:[a-f0-9]{64}$/) });
  for (let i = 0; i < 8; i++) expect(await checker.verify(input())).toEqual(first);
  const restarted = (await createNativePreviewRenderChecker(options(db)))!;
  clock = day + 86_400_000 - 1; // cached immutable facts need no launch even when admission is closed
  expect(await restarted.verify(input())).toEqual(first);
  expect(sdk.launch).toHaveBeenCalledOnce();
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(1);
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_reservations').get()!.n).toBe(1);
  const changed = input(); changed.bytes[10] ^= 1;
  expect(await checker.verify(changed)).toMatchObject({ state: 'failed', reason: 'input-integrity-mismatch' });
  for (const fields of [{ caseId: id('case', 'case-a2') }, { candidateId: 'candidate-a2' }, { assetId: 'asset-a2' }, { resultsVersion: resultsVersion('sha256:' + 'b'.repeat(64)) }]) {
   expect(await checker.verify({ ...input(), ...fields })).toMatchObject({ state: 'pending' }); // NOT cached; near-midnight admission is closed
  }
  expect(await checker.verify({ ...input(), clientId: id('client', 'client-b') })).toMatchObject({ state: 'failed' });
  expect(() => db.sqlite.exec('DELETE FROM npr_success_receipts')).toThrow(/immutable/);
  expect(() => db.sqlite.exec('UPDATE npr_success_receipts SET pages=1')).toThrow(/immutable/);
  expect(sdk.launch).toHaveBeenCalledOnce();
 });
 it('never creates a success receipt for failure, partial render, cleanup failure or timeout', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  boundary.page.evaluate.mockResolvedValueOnce({ state: 'rendered' });
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'failed' });
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
  clock += 82_000;
  boundary.page.close.mockRejectedValueOnce(Error('cleanup failure'));
  expect(await checker.verify(input())).toMatchObject({ state: 'failed' });
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
 });
 it('holds on failed or ambiguous success persistence/readback; a genuine committed receipt can be read later', async () => {
  for (const mode of ['reject', 'ambiguous', 'tamper', 'failed-ack'] as const) {
   const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
   const batch = db.primary.batch.bind(db.primary);
   db.primary.batch = async statements => {
    const sql = (statements[0] as CloudD1Statement & { sql: string }).sql;
    if (!sql.includes('npr_success_receipts')) return batch(statements);
    if (mode === 'reject') throw Error('SYNTHETIC_SECRET_CANARY');
    const outputs = await batch(statements);
    if (mode === 'ambiguous') return [outputs[0], { success: true, results: [] }];
    if (mode === 'failed-ack') return outputs.map(output => ({ ...output as object, success: false }));
    return [outputs[0], { success: true, results: [{ ...(outputs[1] as { results: object[] }).results[0], asset_id: 'other-asset' }] }];
   };
   const checker = (await createNativePreviewRenderChecker(options(db)))!;
   expect(await checker.verify(input())).toMatchObject({ state: 'pending', reason: 'render-receipt-unavailable' });
   expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(mode === 'reject' ? 0 : 1);
   if (mode !== 'reject') expect(await checker.verify(input())).toMatchObject({ state: 'rendered' }); // actual committed exact fake-boundary transcript
  }
 });
 it('validates exact receipt identity, pixel bounds and transcript integrity on every reuse', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  const row = db.sqlite.prepare('SELECT * FROM npr_success_receipts').get()!;
  for (const field of ['client_id', 'case_id', 'candidate_id', 'results_version', 'asset_id', 'input_sha256', 'input_size', 'renderer_version', 'binding_sha256', 'transcript_json', 'transcript_sha256', 'pages', 'canvas_pixels']) {
   const primary = { ...db.primary, prepare: () => ({ first: async () => ({ ...row, [field]: 'corrupt' }), bind() { return this; } }) as CloudD1Statement };
   const bad = (await createNativePreviewRenderChecker({ ...options(db), db: { withSession: () => primary } }))!;
   expect(await bad.verify(input())).toMatchObject({ state: 'pending', reason: 'render-receipt-integrity' });
  }
  const strict = options(db); strict.budget!.maxCanvasPixels = 1;
  expect(await (await createNativePreviewRenderChecker(strict))!.verify(input())).toMatchObject({ state: 'pending' });
  expect(sdk.launch).toHaveBeenCalledOnce();
 });
 it('derives the renderer fingerprint from actual SDK pin, main/worker pins and source program', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  const first = await checker.verify(input());
  const program = String(boundary.served.get('/__clearcase_native_pdf__/inspector.mjs')!.body);
  const html = String(boundary.served.get('/__clearcase_native_pdf__/inspect')!.body);
  const csp = boundary.served.get('/__clearcase_native_pdf__/inspect')!.headers!['content-security-policy'];
  const digest = async (v: unknown) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v)))).toString('hex');
  const expected = await digest({ algorithm: 'clearcase.native-pdf/2', sdkVersion: '1.4.0', sdkIntegrity: 'sha512-39lo96Y7ErOJFmu/KIJU1VLaOibhynx/BauKCZOW5+RVH/mG0jZrAEGJlqCdx5ZxLHyWppm78YX3jLNPCBB+fA==',
   sdkWorkerPolicy: { schema: NATIVE_SDK_BUILD_SCHEMA, inputs: NATIVE_SDK_INPUT_PINS, transforms: NATIVE_SDK_WORKER_OUTPUTS, hostBuffer: NATIVE_SDK_BUFFER_SOURCE, deniedNodeDiagnostics: NATIVE_SDK_DEBUG_SOURCE, hostSymbols: ['Symbol.dispose', 'Symbol.asyncDispose'] }, pdfjsVersion: pins.pdfjsVersion,
   packageDigest: pins.packageDigest, browser: pins.files.find(f => f.path === 'pdfjs/pdf.min.mjs'), worker: pins.files.find(f => f.path === 'pdfjs/pdf.worker.min.mjs'), program: await digest([html, csp, program]) });
  expect(first.rendererVersion).toBe('clearcase.native-pdf/2;sha256:' + expected);
  const altered = { ...db.sqlite.prepare('SELECT * FROM npr_success_receipts').get()!, renderer_version: 'clearcase.native-pdf/2;sha256:' + '0'.repeat(64) };
  const primary = { ...db.primary, prepare: () => ({ first: async () => altered, bind() { return this; } }) as CloudD1Statement };
  expect(await (await createNativePreviewRenderChecker({ ...options(db), db: { withSession: () => primary } }))!.verify(input())).toMatchObject({ state: 'pending' });
 });
 it('aborts SDK HTTP and closes its live/late transport using only the injected binding', async () => {
  const boundary = sdkBoundary(), o = options(), close = vi.fn(), captured: AbortSignal[] = [];
  o.browser = { fetch: vi.fn(async (_url, init) => { captured.push(init!.signal!); return Object.assign(new Response(), { webSocket: { close } }); }) };
  sdk.launch.mockImplementationOnce(async (binding: BrowserWorker) => { await binding.fetch('https://fake.host/v1/devtools/browser', { method: 'POST' }); return boundary.browser; });
  expect(await (await createNativePreviewRenderChecker(o))!.verify(input())).toMatchObject({ state: 'rendered' });
  expect(close).toHaveBeenCalledOnce(); expect(captured[0]!.aborted).toBe(true);
  const late = options(); late.budget!.maxRunMs = 15;
  let release!: (response: Response) => void;
  late.browser = { fetch: vi.fn(() => new Promise<Response>(resolve => { release = resolve; })) };
  sdk.launch.mockImplementationOnce(async (binding: BrowserWorker) => { await binding.fetch('https://fake.host/v1/devtools/browser'); return boundary.browser; });
  expect(await (await createNativePreviewRenderChecker(late))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-timeout' });
  release(Object.assign(new Response(), { webSocket: { close } }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalledTimes(2); expect(boundary.browser.newPage).toHaveBeenCalledOnce();
 });
 it('bounds an SDK hang, consumes the reservation, and closes a late browser without a retry', async () => {
  const boundary = sdkBoundary(), db = rawDatabase(), o = options(db); o.budget!.maxRunMs = 15;
  let release!: (browser: Browser) => void;
  sdk.launch.mockImplementationOnce(() => new Promise<Browser>(resolve => { release = resolve; }));
  const checker = (await createNativePreviewRenderChecker(o))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'failed', reason: 'render-timeout' });
  release(boundary.browser as unknown as Browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(boundary.browser.close).toHaveBeenCalledOnce(); expect(boundary.browser.disconnect).toHaveBeenCalledOnce();
  expect(await checker.verify(input())).toMatchObject({ state: 'pending' }); expect(sdk.launch).toHaveBeenCalledOnce();
 });
 it('caps page and cleanup hangs, rejecting late success', async () => {
  const boundary = sdkBoundary(), o = options(); o.budget!.maxRunMs = 20;
  sdk.launch.mockResolvedValue(boundary.browser);
  boundary.page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
  boundary.page.close.mockImplementationOnce(() => new Promise(() => {}));
  const checker = (await createNativePreviewRenderChecker(o))!;
  const start = performance.now();
  expect(await checker.verify(input())).toMatchObject({ state: 'failed', reason: 'render-cleanup-failed' });
  expect(performance.now() - start).toBeLessThan(3_000); expect(boundary.browser.close).toHaveBeenCalledOnce(); expect(boundary.browser.disconnect).toHaveBeenCalledOnce();
 });
});

describe('actual migration trigger admission with SQLite D1 boundary double (NOT D1/provider acceptance)', () => {
 it('serializes concurrent attempts across fresh checker factories and never refunds a failed launch', async () => {
  const db = rawDatabase(); sdk.launch.mockRejectedValue(Error('deliberate SDK boundary failure'));
  const a = (await createNativePreviewRenderChecker(options(db)))!, b = (await createNativePreviewRenderChecker(options(db)))!;
  const results = await Promise.all([a.verify(input()), b.verify(input())]);
  expect(results.map(r => r.state).sort()).toEqual(['failed', 'pending']); expect(sdk.launch).toHaveBeenCalledOnce();
  expect(db.sqlite.prepare('SELECT runs FROM npr_client_days').get()!.runs).toBe(1);
  clock += 82_000;
  expect(await b.verify(input())).toMatchObject({ state: 'failed' });
  clock += 82_000;
  expect(await a.verify(input())).toMatchObject({ state: 'pending' }); expect(sdk.launch).toHaveBeenCalledTimes(2);
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_reservations').get()!.n).toBe(2);
 });
 it('caps all cases in a client, allows only a monotonic UTC reset, and preserves immutable receipts', async () => {
  const db = rawDatabase(); sdk.launch.mockRejectedValue(Error('deliberate failure'));
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  for (let i = 0; i < 4; i++) { expect(await checker.verify({ ...input(), caseId: id('case', `case-${i}`) })).toMatchObject({ state: 'failed' }); clock += 82_000; }
  expect(await checker.verify({ ...input(), caseId: id('case', 'case-extra') })).toMatchObject({ state: 'pending' });
  clock = day - 1_000;
  expect(await checker.verify(input())).toMatchObject({ state: 'pending' });
  clock = day + 86_400_000 + 1_000;
  expect(await checker.verify(input())).toMatchObject({ state: 'failed' });
  clock = day + 1_000;
  expect(await checker.verify(input())).toMatchObject({ state: 'pending' });
  expect(db.sqlite.prepare('SELECT runs,day FROM npr_client_days').get()).toMatchObject({ runs: 1, day: 20_001 });
  expect(() => db.sqlite.exec('DELETE FROM npr_reservations')).toThrow(/immutable/);
  expect(() => db.sqlite.exec('UPDATE npr_reservations SET input_size=1')).toThrow(/immutable/);
 });
 it('rejects a near-midnight launch rather than undercharging tomorrow', async () => {
  const checker = (await createNativePreviewRenderChecker(options()))!;
  clock = day + 86_400_000 - 82_000;
  expect(await checker.verify(input())).toMatchObject({ state: 'pending' }); expect(sdk.launch).not.toHaveBeenCalled();
 });
 it('rejects missing migration, failed/ambiguous commit and stale/nonprimary DB shape before launch', async () => {
  for (const which of ['missing', 'ambiguous', 'failed-ack'] as const) {
   const db = rawDatabase(), o = options(db), batch = db.primary.batch.bind(db.primary);
   if (which === 'missing') db.sqlite.exec('DROP TABLE npr_reservations');
   else if (which === 'ambiguous') db.primary.batch = async () => [{ success: true, results: [] }];
   else db.primary.batch = async statements => (await batch(statements)).map(output => ({ ...output as object, success: false }));
   expect(await (await createNativePreviewRenderChecker(o))!.verify(input())).toMatchObject({ state: 'pending' });
  }
  expect(await createNativePreviewRenderChecker({ ...options(), db: {} as NativePreviewRenderOptions['db'] })).toBeNull();
  expect(sdk.launch).not.toHaveBeenCalled();
 });
});

describe('host disposal symbol preflight (NOT workerd acceptance)', () => {
 it('names exactly the two host disposal symbols the transformed SDK reads', () => {
  expect(NATIVE_SDK_HOST_SYMBOLS).toEqual(['Symbol.dispose', 'Symbol.asyncDispose']);
  expect(Object.isFrozen(NATIVE_SDK_HOST_SYMBOLS)).toBe(true);
 });
 it.each(['dispose', 'asyncDispose'] as const)('is unavailable, never polyfilled, on a host without Symbol.%s', async missing => {
  const host = Symbol, partial = Object.assign((description?: string) => host(description), { dispose: host.dispose, asyncDispose: host.asyncDispose, [missing]: undefined });
  vi.stubGlobal('Symbol', partial);
  try {
   expect(await createNativePreviewRenderChecker(options())).toBeNull();
   expect(partial[missing]).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
  expect(sdk.launch).not.toHaveBeenCalled();
  expect(await createNativePreviewRenderChecker(options())).not.toBeNull();
 });
});
