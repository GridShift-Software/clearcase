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
 // The deployed chain: the case-limit migration admits the ceiling budget's case limit of 3.
 sqlite.exec(`BEGIN;\n${readFileSync('src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql', 'utf8')}\nCOMMIT;`);
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
 const browserListeners = new Set<() => void>();
 let connected = true;
 const peerClosed = () => { connected = false; for (const listener of browserListeners) listener(); };
 const control = { send: vi.fn(async (_method: string, _params?: unknown, _options?: unknown): Promise<unknown> => { peerClosed(); return {}; }) };
 const browser = {
  newPage: vi.fn(async () => page as unknown as Page), close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  get connected() { return connected; },
  target: vi.fn(() => ({ createCDPSession: vi.fn(async () => ({ connection: () => control })) })),
  on: vi.fn((_name: string, listener: () => void) => { browserListeners.add(listener); }),
  off: vi.fn((_name: string, listener: () => void) => { browserListeners.delete(listener); }),
 };
 return { page, browser, control, peerClosed, request, served, emit: (name: string, ...args: unknown[]) => { for (const fn of listeners.get(name) ?? []) fn(...args); } };
}
// These case-cap probes keep today's deployed case limit of 2; the ceiling of 3 is probed in case-ceiling.test.ts.
const CASE_LIMIT_TWO = { ...NATIVE_PDF_RENDER_CEILINGS, maxRunsPerCasePerDay: 2 };
function options(db = rawDatabase(), budget: NativePreviewRenderOptions['budget'] = { ...NATIVE_PDF_RENDER_CEILINGS }): NativePreviewRenderOptions {
 return {
  db, clientId, browser: { fetch: vi.fn(async () => { throw Error('inert BROWSER double: no provider call'); }) } as BrowserWorker,
  assets: { fetch: vi.fn(async (request: Request) => new Response(readFileSync(join(root, new URL(request.url).pathname)))) },
  appOrigin: 'https://app.example', pins: structuredClone(pins), budget, now: () => new Date(clock),
 };
}
beforeEach(() => { sdk.launch.mockReset(); clock = day + 10_000; });


import { Connection } from '@cloudflare/puppeteer/lib/esm/puppeteer/cdp/Connection.js';
import { CdpBrowser } from '@cloudflare/puppeteer/lib/esm/puppeteer/cdp/Browser.js';
import { connectToCDPBrowser } from '@cloudflare/puppeteer/lib/esm/puppeteer/cloudflare/utils.js';

describe('source security regressions; inert CDP/PDF/Worker doubles, NOT native acceptance', () => {
 it.each(['raw', 'coded'])('P1: bypasses the actual SDK swallowed close callback on %s control failure', async mode => {
  const db = rawDatabase(), boundary = sdkBoundary();
  const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
  const fault = mode === 'raw' ? 'SYNTHETIC_CLOSE_SECRET_CANARY' : Object.assign(Error('SYNTHETIC_CLOSE_SECRET_CANARY'), { code: 'SYNTHETIC_SESSION_CANARY' });
  const send = vi.spyOn(Connection.prototype, 'send').mockImplementation(async (method: string) => {
   if (method === 'Browser.getVersion') return { product: 'Chrome', protocolVersion: 'inert', revision: 'inert', userAgent: 'inert', jsVersion: 'inert' };
   if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
   if (method === 'Browser.close') throw fault;
   throw Error('unexpected inert protocol call');
  });
  const construct = vi.spyOn(CdpBrowser, '_create').mockImplementation(async (...args) => {
   // The real SDK callback still swallows/logs; the owned cleanup must NEVER call it.
   boundary.browser.close.mockImplementation(async () => { await args[6]!(); });
   boundary.control.send.mockImplementation((method: string) => args[1].send(method as 'Browser.close'));
   return boundary.browser as unknown as CdpBrowser;
  });
  try {
   const b = await connectToCDPBrowser({ send() { throw Error('inert transport'); }, close() {} }, {});
   sdk.launch.mockResolvedValue(b);
   expect(await (await createNativePreviewRenderChecker(options(db)))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-cleanup-failed' });
   expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
   expect(boundary.control.send).toHaveBeenCalledWith('Browser.close', undefined, { timeout: expect.any(Number) });
   expect(boundary.browser.close).not.toHaveBeenCalled();
   for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { construct.mockRestore(); send.mockRestore(); logs.forEach(log => log.mockRestore()); }
 });

 it.each(['no-ack', 'error-ack', 'array-ack', 'primitive-ack', 'no-peer-close', 'send-hang', 'session-hang', 'no-connection'])('refuses unknown cleanup outcome: %s', async mode => {
  const db = rawDatabase(), boundary = sdkBoundary();
  if (mode === 'no-ack') boundary.control.send.mockImplementation(async () => { boundary.peerClosed(); return undefined; });
  if (mode === 'error-ack') boundary.control.send.mockResolvedValue({ error: { code: -1, message: 'SYNTHETIC_SECRET_CANARY' } });
  if (mode === 'array-ack' || mode === 'primitive-ack') boundary.control.send.mockImplementation(async () => { boundary.peerClosed(); return mode === 'array-ack' ? [] : true; });
  if (mode === 'no-peer-close') boundary.control.send.mockResolvedValue({});
  if (mode === 'send-hang') boundary.control.send.mockImplementation(() => new Promise(() => {}));
  if (mode === 'session-hang') boundary.browser.target.mockReturnValue({ createCDPSession: vi.fn(() => new Promise(() => {})) });
  if (mode === 'no-connection') boundary.browser.target.mockReturnValue({ createCDPSession: vi.fn(async () => ({ connection: () => undefined as unknown as typeof boundary.control })) });
  sdk.launch.mockResolvedValue(boundary.browser);
  const start = performance.now();
  expect(await (await createNativePreviewRenderChecker(options(db)))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-cleanup-failed' });
  expect(performance.now() - start).toBeLessThan(3_000);
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
  expect(db.sqlite.prepare('SELECT runs FROM npr_client_days').get()!.runs).toBe(1);
  expect(boundary.browser.close).not.toHaveBeenCalled();
  expect(boundary.browser.disconnect).toHaveBeenCalledOnce();
 });

 it('requires a close acknowledgement AND peer termination before persisting, then reuses the exact fact', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  let acknowledge!: (v: object) => void;
  boundary.control.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  const run = checker.verify(input());
  await vi.waitFor(() => expect(boundary.control.send).toHaveBeenCalledOnce());
  acknowledge({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
  boundary.peerClosed();
  expect(await run).toMatchObject({ state: 'rendered' });
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  expect(sdk.launch).toHaveBeenCalledOnce(); expect(boundary.browser.close).not.toHaveBeenCalled();
 });

 it('never sends late cleanup commands beyond the originally charged cleanup window', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(), o = options(db); o.budget!.maxRunMs = 15;
  let release!: (value: unknown) => void;
  sdk.launch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  expect(await (await createNativePreviewRenderChecker(o))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-timeout' });
  await new Promise(resolve => setTimeout(resolve, 2_050));
  release(boundary.browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(boundary.control.send).not.toHaveBeenCalled();
  expect(boundary.browser.close).not.toHaveBeenCalled();
  expect(boundary.browser.disconnect).toHaveBeenCalledOnce();
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
  expect(db.sqlite.prepare('SELECT runs FROM npr_client_days').get()!.runs).toBe(1);
 });

 it('P2: REPLACE cannot rewrite a transcript and digest into a reusable success', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  const row = db.sqlite.prepare('SELECT * FROM npr_success_receipts').get()!;
  const transcript = JSON.parse(String(row.transcript_json));
  transcript.pages.forEach((p: { pixelSha256: string }) => { p.pixelSha256 = 'e'.repeat(64); });
  row.transcript_json = JSON.stringify(transcript);
  row.transcript_sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(row.transcript_json)))).toString('hex');
  const columns = Object.keys(row);
  expect(() => db.sqlite.prepare('INSERT OR REPLACE INTO npr_success_receipts (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...Object.values(row))).toThrow(/immutable/);
  expect(db.sqlite.prepare('SELECT transcript_sha256 FROM npr_success_receipts').get()!.transcript_sha256).not.toBe(row.transcript_sha256);
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
 });

 it.each(['page-raw', 'page-coded', 'page-sync', 'disconnect-raw', 'disconnect-coded', 'disconnect-sync', 'transport'])('sanitizes cleanup boundary faults and never refunds or certifies: %s', async mode => {
  const db = rawDatabase(), boundary = sdkBoundary(), o = options(db);
  const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
  const fault = mode.endsWith('raw') ? 'SYNTHETIC_CLEANUP_SECRET_CANARY' : Object.assign(Error('SYNTHETIC_CLEANUP_SECRET_CANARY'), { code: 'SYNTHETIC_SESSION_SECRET_CANARY' });
  if (mode.startsWith('page')) boundary.page.close.mockRejectedValue(fault);
  if (mode === 'page-sync') boundary.page.close.mockImplementation(() => { throw fault; });
  if (mode.startsWith('disconnect')) boundary.browser.disconnect.mockRejectedValue(fault);
  if (mode === 'disconnect-sync') boundary.browser.disconnect.mockImplementation(() => { throw fault; });
  if (mode === 'transport') {
   o.browser = { fetch: async () => Object.assign(new Response(), { webSocket: { close() { throw fault; } } }) };
   sdk.launch.mockImplementation(async (binding: BrowserWorker) => { await binding.fetch('https://fake.host/inert'); return boundary.browser; });
  } else sdk.launch.mockResolvedValue(boundary.browser);
  try {
   const checker = (await createNativePreviewRenderChecker(o))!;
   expect(await checker.verify(input())).toMatchObject({ state: 'failed', reason: 'render-cleanup-failed' });
   expect(boundary.control.send).toHaveBeenCalledOnce();
   expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(0);
   expect(await checker.verify(input())).toMatchObject({ state: 'pending' });
   expect(sdk.launch).toHaveBeenCalledOnce();
   for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { logs.forEach(log => log.mockRestore()); }
 });

 it.each([true, false, undefined, 'true', null, 'metadata-error'])('P3: rejects XFA/unknown metadata before any page with XFA generation disabled: %s', async xfa => {
  const boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  await (await createNativePreviewRenderChecker(options()))!.verify(input());
  const program = String(boundary.served.get('/__clearcase_native_pdf__/inspector.mjs')!.body)
   .replace("import * as pdfjs from '/pdfjs/pdf.min.mjs';", '');
  const workerBytes = readFileSync(join(root, 'pdfjs/pdf.worker.min.mjs'));
  const metadata = vi.fn(async () => { if (xfa === 'metadata-error') throw Error('SYNTHETIC_XFA_SECRET_CANARY'); return { info: { IsXFAPresent: xfa } }; });
  const getPage = vi.fn(async () => ({ getJSActions: async () => null, getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} }));
  const fakeDoc = { numPages: 1, isPureXfa: false, getMetadata: metadata, getJSActions: async () => null, getPage };
  const getDocument = vi.fn((_options: unknown) => ({ promise: Promise.resolve(fakeDoc), destroy: vi.fn(async () => {}) }));
  const fakePdfjs = { version: '6.4.299', GlobalWorkerOptions: {}, AnnotationMode: { ENABLE: 1 }, getDocument };
  const target: { clearcaseNativePdfInspect?: (v: unknown) => Promise<unknown> } = {};
  // Only the owned program executes. All PDF/canvas/Worker APIs below are inert doubles, not PDF.js acceptance.
  const install = new Function('pdfjs', 'window', 'Worker', 'fetch', 'document', 'location', 'console', 'setTimeout', 'clearTimeout', program);
  const terminate = vi.fn(), getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(4) }));
  class InertWorker { addEventListener() {} terminate() { terminate(); } }
  install(fakePdfjs, target, InertWorker,
   async (path: string) => new Response(path.endsWith('input.pdf') ? bytes : workerBytes),
   { createElement: () => ({ width: 0, height: 0, getContext: () => ({ getImageData }) }) },
   { origin: 'https://app.example' }, {}, () => 0, () => {});
  const run = target.clearcaseNativePdfInspect!({ binding: 'synthetic', sha256, size: bytes.length, maxPages: 8, maxCanvasPixels: 4_000_000, maxRunMs: 20_000,
   workerBytes: workerBytes.length, workerSha256: Buffer.from(await crypto.subtle.digest('SHA-256', workerBytes)).toString('hex') });
  if (xfa === false) {
   await expect(run).resolves.toMatchObject({ totalPages: 1, pages: [{ number: 1, width: 1, height: 1, pixelBytes: 4 }] });
   expect(getPage).toHaveBeenCalledOnce(); expect(getImageData).toHaveBeenCalledOnce();
  } else {
   await expect(run).rejects.toThrow();
   expect(getPage).not.toHaveBeenCalled(); expect(getImageData).not.toHaveBeenCalled();
  }
  expect(metadata).toHaveBeenCalledOnce();
  expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ enableXfa: false, enableScripting: false, isEvalSupported: false, useWasm: false }));
  expect(terminate).toHaveBeenCalledOnce();
 });
});

describe('SQLite conflict strategies cannot bypass any render invariant; NOT D1 acceptance', () => {
 it.each([0, 1])('seals every immutable/monotonic table with recursive_triggers=%i', async recursive => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  db.sqlite.exec('PRAGMA recursive_triggers=' + recursive);
  const checker = (await createNativePreviewRenderChecker(options(db, CASE_LIMIT_TWO)))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  clock += 82_000;
  // A second reservation legitimately updates both counters within the same atomic insertion.
  sdk.launch.mockResolvedValue(sdkBoundary().browser);
  expect(await checker.verify({ ...input(), assetId: 'second-asset' })).toMatchObject({ state: 'rendered' });
  for (const table of ['npr_reservations', 'npr_success_receipts', 'npr_client_days', 'npr_case_days']) {
   const row = db.sqlite.prepare('SELECT * FROM ' + table).get()!;
   const before = db.sqlite.prepare('SELECT * FROM ' + table).all();
   const keys = Object.keys(row);
   const field = table === 'npr_reservations' ? 'input_size' : table === 'npr_success_receipts' ? 'pages' : 'runs';
   const mutated = { ...row, [field]: 1 };
   for (const strategy of ['INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE', 'INSERT']) {
    const values = keys.map(key => mutated[key]);
    const suffix = strategy === 'INSERT' ? ' ON CONFLICT DO UPDATE SET ' + field + '=excluded.' + field : '';
    expect(() => db.sqlite.prepare(strategy + ' INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')' + suffix).run(...values)).toThrow();
    expect(db.sqlite.prepare('SELECT * FROM ' + table).all()).toEqual(before);
   }
   expect(() => db.sqlite.exec('UPDATE OR REPLACE ' + table + ' SET ' + field + '=1')).toThrow();
   expect(() => db.sqlite.exec('DELETE FROM ' + table)).toThrow(/immutable/);
   // There is no hidden rowid replacement identity, on ANY of the four tables.
   expect(() => db.sqlite.prepare('SELECT rowid FROM ' + table).get()).toThrow();
   expect(db.sqlite.prepare('SELECT * FROM ' + table).all()).toEqual(before);
  }
  const receipt = db.sqlite.prepare('SELECT * FROM npr_success_receipts LIMIT 1').get()!;
  const columns = Object.keys(receipt);
  for (const suffix of ['', ' ON CONFLICT(binding_sha256) DO NOTHING', ' ON CONFLICT DO UPDATE SET pages=excluded.pages']) {
   for (const insert of ['INSERT', 'INSERT OR REPLACE']) {
    db.sqlite.prepare(insert + ' INTO npr_success_receipts (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')' + suffix).run(...Object.values(receipt));
   }
  }
  expect(db.sqlite.prepare('SELECT count(*) n FROM npr_success_receipts').get()!.n).toBe(2);
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  expect(sdk.launch).toHaveBeenCalledTimes(2);
  clock += 82_000;
  expect(await checker.verify({ ...input(), assetId: 'third-asset' })).toMatchObject({ state: 'pending' });
 });

 it('rejects conflicts through every receipt unique key, not only the primary digest', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  expect(await (await createNativePreviewRenderChecker(options(db)))!.verify(input())).toMatchObject({ state: 'rendered' });
  const row = db.sqlite.prepare('SELECT * FROM npr_success_receipts').get()!;
  const columns = Object.keys(row);
  for (const mutation of [{ pages: 1 }, { binding_sha256: 'e'.repeat(64), asset_id: 'other' }, { binding_sha256: 'e'.repeat(64), reservation_token: 'other' }] satisfies (Partial<typeof row>)[]) {
   const changed = Object.assign({ ...row }, mutation);
   expect(() => db.sqlite.prepare('INSERT OR REPLACE INTO npr_success_receipts (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...columns.map(key => changed[key]))).toThrow(/immutable/);
  }
  expect(db.sqlite.prepare('SELECT * FROM npr_success_receipts').get()).toEqual(row);
 });

 it('rejects direct quota reset/refund/lease shortening/identity swaps and fake projection rows', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options(db, CASE_LIMIT_TWO)))!;
  await checker.verify(input());
  clock += 82_000;
  sdk.launch.mockResolvedValue(sdkBoundary().browser);
  expect(await checker.verify({ ...input(), assetId: 'second' })).toMatchObject({ state: 'rendered' });
  for (const table of ['npr_client_days', 'npr_case_days']) {
   const before = db.sqlite.prepare('SELECT * FROM ' + table).all();
   for (const set of ["day=day-1", "day=day+1,runs=1", "runs=runs-1", "runs=runs+1", "client_id='forged'"]) {
    expect(() => db.sqlite.exec('UPDATE OR REPLACE ' + table + ' SET ' + set)).toThrow();
   }
   if (table === 'npr_client_days') {
    expect(() => db.sqlite.exec('UPDATE npr_client_days SET next_launch_ms=next_launch_ms-1')).toThrow();
    expect(() => db.sqlite.exec('UPDATE npr_client_days SET next_launch_ms=next_launch_ms+1')).toThrow();
    expect(() => db.sqlite.exec("INSERT INTO npr_client_days VALUES ('forged',20001,1,1)")).toThrow(/projection/);
   } else {
    expect(() => db.sqlite.exec("UPDATE OR REPLACE npr_case_days SET case_id='forged'")).toThrow();
    expect(() => db.sqlite.exec("INSERT INTO npr_case_days VALUES ('client-a','forged',20001,1)")).toThrow(/projection/);
   }
   expect(db.sqlite.prepare('SELECT * FROM ' + table).all()).toEqual(before);
   db.sqlite.exec('UPDATE ' + table + ' SET runs=runs'); // A verified exact projection is safely idempotent.
  }
  const before = db.sqlite.prepare('SELECT * FROM npr_client_days').get();
  clock += 82_000;
  expect(await checker.verify({ ...input(), assetId: 'third' })).toMatchObject({ state: 'pending' });
  expect(db.sqlite.prepare('SELECT * FROM npr_client_days').get()).toEqual(before);
  clock = day + 86_400_000 + 10_000;
  const fresh = sdkBoundary(); sdk.launch.mockResolvedValue(fresh.browser);
  expect(await (await createNativePreviewRenderChecker(options(db, CASE_LIMIT_TWO)))!.verify({ ...input(), assetId: 'tomorrow' })).toMatchObject({ state: 'rendered' });
  expect(db.sqlite.prepare('SELECT day,runs FROM npr_client_days').get()).toMatchObject({ day: 20001, runs: 1 });
 });

 it('rejects UPDATE OR REPLACE identity collisions before either existing row can be deleted', async () => {
  const db = rawDatabase(); sdk.launch.mockImplementation(async () => sdkBoundary().browser);
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  expect(await checker.verify(input())).toMatchObject({ state: 'rendered' });
  clock += 82_000;
  expect(await checker.verify({ ...input(), caseId: id('case', 'case-a2') })).toMatchObject({ state: 'rendered' });
  const otherClient = id('client', 'client-b');
  const second = (await createNativePreviewRenderChecker({ ...options(db), clientId: otherClient }))!;
  expect(await second.verify({ ...input(), clientId: otherClient })).toMatchObject({ state: 'rendered' });
  for (const [table, key] of [
   ['npr_client_days', 'client_id'], ['npr_case_days', 'case_id'], ['npr_reservations', 'token'], ['npr_success_receipts', 'binding_sha256'],
  ]) {
   const rows = db.sqlite.prepare('SELECT * FROM ' + table).all(), before = rows.map(row => ({ ...row }));
   expect(rows.length).toBeGreaterThanOrEqual(2);
   expect(() => db.sqlite.prepare('UPDATE OR REPLACE ' + table + ' SET ' + key + '=? WHERE ' + key + '=?').run(rows[1][key], rows[0][key])).toThrow();
   expect(db.sqlite.prepare('SELECT * FROM ' + table).all()).toEqual(before);
  }
 });

 it('rolls back the reservation AND both counter changes when a trigger refuses admission', async () => {
  const db = rawDatabase(), boundary = sdkBoundary(); sdk.launch.mockResolvedValue(boundary.browser);
  const checker = (await createNativePreviewRenderChecker(options(db)))!;
  await checker.verify(input());
  const snapshot = () => ['npr_reservations', 'npr_client_days', 'npr_case_days'].map(table => db.sqlite.prepare('SELECT * FROM ' + table).all());
  const before = snapshot();
  // Deliberately fail the last counter write to probe all-or-nothing trigger admission under OR REPLACE/IGNORE too.
  db.sqlite.exec("CREATE TRIGGER synthetic_case_counter_fault BEFORE UPDATE ON npr_case_days BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END");
  const row = db.sqlite.prepare('SELECT * FROM npr_reservations').get()!;
  const changed: typeof row = { ...row, token: 'new-token', started_ms: Number(row.started_ms) + 82_000 };
  const columns = Object.keys(changed);
  for (const insert of ['INSERT', 'INSERT OR REPLACE', 'INSERT OR IGNORE']) {
   expect(() => db.sqlite.prepare(insert + ' INTO npr_reservations (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...columns.map(key => changed[key]))).toThrow(/synthetic refusal/);
   expect(snapshot()).toEqual(before);
  }
 });
});
