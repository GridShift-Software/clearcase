// REAL @cloudflare/puppeteer 1.4.0 over an in-process CDP peer double. No browser, provider, workerd or PDF rendering.
// The BROWSER binding double models ONE workerd fact, cited below. This is NOT native acceptance or cleanup proof.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import type { CloudD1, CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { createNativePreviewRenderChecker, NATIVE_PDF_RENDER_CEILINGS, type NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';

const root = mkdtempSync(join(tmpdir(), 'clearcase-native-pdf-order-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bytes = new TextEncoder().encode('%PDF-1.7\nSYNTHETIC TRANSPORT ORDER INPUT; NOT A RENDERABLE PDF.');
const sha256 = await crypto.subtle.digest('SHA-256', bytes).then(b => Buffer.from(b).toString('hex'));
const clientId = id('client', 'client-a'), caseId = id('case', 'case-a1');
const input = () => ({ clientId, caseId, candidateId: 'candidate-a1', resultsVersion: resultsVersion('sha256:' + 'a'.repeat(64)), assetId: 'preview-a1', mediaType: 'application/pdf', bytes: bytes.slice(), sha256 });
const clock = 20_000 * 86_400_000 + 10_000;
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
 return { sqlite, primary, withSession: vi.fn(() => primary) };
}

const browserTarget = { targetId: 'inert-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false };
type Listener = (event: { data?: string }) => void;
/**
 * Inert BROWSER binding and CDP peer. The peer acknowledges root Browser.close with {} and then disconnects.
 * workerd src/workerd/api/http.c++ handleWebSocketFetchResponse wraps a 101 socket in AbortableWebSocket bound to the
 * upgrade request's signal; src/workerd/util/abortable.h drops the inner socket when that signal aborts. With
 * tieUpgradeToSignal the double models only that: nothing crosses the socket after the upgrade signal aborts.
 */
function browserBinding(o: { tieUpgradeToSignal: boolean; createTarget: 'refuse' | 'hang' }) {
 const delivered: string[] = [], acquired: AbortSignal[] = [];
 const binding: BrowserWorker = { fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'POST' && new URL(String(url)).pathname === '/v1/devtools/browser') {
   acquired.push(init.signal!);
   return new Response(JSON.stringify({ sessionId: 'inert-session' }));
  }
  expect(new Headers(init?.headers).get('upgrade')).toBe('websocket');
  const listeners = new Map<string, Listener[]>();
  let dropped = false, open = true;
  if (o.tieUpgradeToSignal) init!.signal!.addEventListener('abort', () => { dropped = true; }, { once: true });
  const dispatch = (type: string, event: { data?: string }) => { for (const fn of listeners.get(type) ?? []) fn(event); };
  const deliver = (message: object) => setTimeout(() => { if (!dropped && open) dispatch('message', { data: JSON.stringify(message) }); }, 0);
  const webSocket = {
   accept() {},
   addEventListener(type: string, fn: Listener) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
   close() { open = false; },
   send(raw: string) {
    if (dropped || !open) return;
    const m = JSON.parse(raw) as { id: number; method: string };
    delivered.push(m.method);
    const reply = (result: object) => deliver({ id: m.id, result });
    switch (m.method) {
     case 'Browser.getVersion': return reply({ product: 'HeadlessChrome/0', protocolVersion: '1.3', revision: 'inert', userAgent: 'inert', jsVersion: 'inert' });
     case 'Target.getBrowserContexts': return reply({ browserContextIds: [] });
     case 'Target.setDiscoverTargets': deliver({ method: 'Target.targetCreated', params: { targetInfo: browserTarget } }); return reply({});
     case 'Target.setAutoAttach': return reply({});
     case 'Target.createTarget': if (o.createTarget === 'refuse') deliver({ id: m.id, error: { code: -32000, message: 'inert refusal' } }); return;
     case 'Target.attachToTarget':
      deliver({ method: 'Target.attachedToTarget', params: { sessionId: 'inert-root', targetInfo: browserTarget, waitingForDebugger: false } });
      return reply({ sessionId: 'inert-root' });
     case 'Browser.close':
      reply({});
      return void setTimeout(() => { if (!dropped && open) { open = false; dispatch('close', {}); } }, 0);
     default: return deliver({ id: m.id, error: { code: -32601, message: 'inert peer: unexpected method' } });
    }
   },
  };
  return Object.assign(new Response(null), { webSocket });
 } } as BrowserWorker;
 return { binding, delivered, acquired };
}
function options(browser: BrowserWorker): NativePreviewRenderOptions {
 return {
  db: rawDatabase(), clientId, browser,
  assets: { fetch: vi.fn(async (request: Request) => new Response(readFileSync(join(root, new URL(request.url).pathname)))) },
  appOrigin: 'https://app.example', pins: structuredClone(pins), budget: { ...NATIVE_PDF_RENDER_CEILINGS }, now: () => new Date(clock),
 };
}

describe('deadline abort versus the live CDP transport (real SDK 1.4.0, inert peer, NOT native cleanup proof)', () => {
 it.each([false, true])('delivers the owned root Browser.close after completed work; upgrade tied to its signal: %s', async tieUpgradeToSignal => {
  const peer = browserBinding({ tieUpgradeToSignal, createTarget: 'refuse' });
  expect(await (await createNativePreviewRenderChecker(options(peer.binding)))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-failed', stage: 'page-setup' });
  expect(peer.delivered.slice(-2)).toEqual(['Target.attachToTarget', 'Browser.close']);
  expect(peer.acquired).toHaveLength(1); expect(peer.acquired[0]!.aborted).toBe(true);
 });
 it('delivers the owned root Browser.close after a deadline, keeping render-timeout and its phase', async () => {
  const peer = browserBinding({ tieUpgradeToSignal: true, createTarget: 'hang' }), o = options(peer.binding); o.budget!.maxRunMs = 300;
  expect(await (await createNativePreviewRenderChecker(o))!.verify(input())).toMatchObject({ state: 'failed', reason: 'render-timeout', stage: 'page-setup' });
  expect(peer.delivered.slice(-2)).toEqual(['Target.attachToTarget', 'Browser.close']);
  expect(peer.acquired[0]!.aborted).toBe(true);
 });
});
