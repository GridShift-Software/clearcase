// SDK BOUNDARY DOUBLES ONLY. No browser, provider, workerd or PDF rendering runs here: the page double fabricates
// canvas proofs for the pages the server asks for, from a scripted page count per input digest. NEVER renderer acceptance.
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWorker, HTTPRequest } from '@cloudflare/puppeteer';
import type { CloudD1, CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import type { NativePdfEvidenceOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import type { NativePreviewRenderPins } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import type { PdfEvidenceDocument } from '../../../src/lib/viewer/hosted/render-check-contract.ts';

export const DAY_MS = 86_400_000;
export const clientId = id('client', 'client-a'), caseId = id('case', 'case-a1');
export const rv = (n: string) => resultsVersion('sha256:' + n.repeat(64));
const MIGRATIONS = ['0001_preview_render_work.sql', '0002_preview_render_case_limit.sql', '0003_content_receipts.sql', '0004_pdf_evidence_sessions.sql']
 .map(f => join('src/lib/viewer/hosted/migrations', f));

/** Synthetic bytes: a PDF header and a tag. Their page count lives only in the browser double's script. */
export function syntheticPdf(tag: string) {
 const bytes = new TextEncoder().encode(`%PDF-1.7\n% synthetic ${tag}; not a renderable PDF\n`);
 return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

/** The real migration and trigger SQL in SQLite, behind a labelled in-process D1 double that counts calls and can be killed. */
export function pdfDatabase(sqlite = new DatabaseSync(':memory:')) {
 if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='npr_content_receipts'").get()) {
  for (const file of MIGRATIONS) { sqlite.exec('BEGIN'); sqlite.exec(readFileSync(file, 'utf8')); sqlite.exec('COMMIT'); }
 }
 const state = { calls: 0, killed: false, killAfterReceipts: Infinity, receiptWrites: 0 };
 const alive = () => { state.calls++; if (state.killed) throw Error('isolate killed'); };
 type Statement = CloudD1Statement & { sql: string; values: (string | number | null)[] };
 const primary: CloudD1 = {
  prepare(sql) {
   const s: Statement = {
    sql, values: [], bind(...values) { s.values = values; return s; },
    async all<T>() { alive(); return { results: sqlite.prepare(sql).all(...s.values) as T[] }; },
    async first<T>() { alive(); return (sqlite.prepare(sql).get(...s.values) ?? null) as T | null; },
    async run() { alive(); return sqlite.prepare(sql).run(...s.values); },
   }; return s;
  },
  async batch(statements) {
   alive();
   if (statements.some(s => (s as Statement).sql.includes('INSERT INTO npr_content_receipts'))) {
    if (state.receiptWrites >= state.killAfterReceipts) { state.killed = true; throw Error('isolate killed'); }
    state.receiptWrites++;
   }
   sqlite.exec('BEGIN IMMEDIATE');
   try {
    const outputs = statements.map(s => { const { sql, values } = s as Statement; return { success: true, results: sqlite.prepare(sql).all(...values) }; });
    sqlite.exec('COMMIT'); return outputs;
   } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
 };
 return { sqlite, state, primary, withSession: vi.fn((_constraint: 'first-primary') => primary) };
}

export type PdfScript = { totalPages: number; behaviour?: 'corrupt' | 'violate' | 'omit-page' };
/**
 * A browser double with one isolated context per document. `evaluate` answers from `script` by input digest, for exactly the
 * pages the server asked for that exist, the way the page program does. It records every document it was asked to inspect.
 */
export function pdfBrowser(script: Map<string, PdfScript>) {
 const inspected: { sha256: string; pages: number[] }[] = [];
 const contexts = { opened: 0, closed: 0 };
 let connected = true;
 const closedListeners = new Set<() => void>();
 const newPage = () => {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const mainFrame = {};
  const request = async (url: string, type = 'script') => {
   let finish!: () => void;
   const done = new Promise<void>(resolve => { finish = resolve; });
   const req = {
    url: () => url, method: () => 'GET', resourceType: () => type, isNavigationRequest: () => type === 'document', frame: () => mainFrame,
    respond: vi.fn(async () => { finish(); }), abort: vi.fn(async () => { finish(); }),
   };
   for (const f of listeners.get('request') ?? []) f(req as unknown as HTTPRequest);
   await done;
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
   evaluate: vi.fn(async (_fn: unknown, args: { binding: string; sha256: string; size: number; pages: number[] }): Promise<unknown> => {
    await request('https://app.example/__clearcase_native_pdf__/input.pdf', 'fetch');
    await request('https://app.example/pdfjs/pdf.worker.min.mjs', 'fetch');
    const s = script.get(args.sha256);
    inspected.push({ sha256: args.sha256, pages: [...args.pages] });
    if (!s || s.behaviour === 'corrupt') throw Error('inspection refused');
    if (s.behaviour === 'violate') await request('https://app.example/private/case-data', 'fetch');
    const pages = args.pages.filter(n => n <= s.totalPages).slice(0, s.behaviour === 'omit-page' ? -1 : undefined);
    return { binding: args.binding, sha256: args.sha256, size: args.size, pdfjsVersion: '6.4.299', totalPages: s.totalPages,
     pages: pages.map(number => ({ number, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'c'.repeat(64) })) };
   }),
   close: vi.fn(async () => {}),
  };
  return page;
 };
 const browser = {
  createBrowserContext: vi.fn(async () => { contexts.opened++; return { newPage: async () => newPage(), close: async () => { contexts.closed++; } }; }),
  newPage: vi.fn(async () => { throw Error('pages run inside an isolated context'); }),
  close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  get connected() { return connected; },
  on(_name: string, listener: () => void) { closedListeners.add(listener); },
  off(_name: string, listener: () => void) { closedListeners.delete(listener); },
  target: () => ({ createCDPSession: async () => ({ connection: () => ({
   send: async () => { await browser.close(); connected = false; for (const listener of closedListeners) listener(); return {}; },
  }) }) }),
 };
 return { browser, inspected, contexts };
}

export function evidenceOptions(db: ReturnType<typeof pdfDatabase>, pins: NativePreviewRenderPins, root: string, clock: () => number,
 budget: Partial<NonNullable<NativePdfEvidenceOptions['budget']>> = {}, base?: NonNullable<NativePdfEvidenceOptions['budget']>): NativePdfEvidenceOptions {
 return {
  db, clientId, browser: { fetch: vi.fn(async () => { throw Error('inert BROWSER double: no provider call'); }) } as BrowserWorker,
  assets: { fetch: vi.fn(async (request: Request) => new Response(readFileSync(join(root, new URL(request.url).pathname)))) },
  appOrigin: 'https://app.example', pins: structuredClone(pins), budget: base && { ...base, ...budget }, now: () => new Date(clock()),
 };
}

/** One candidate document over synthetic bytes; `reads` counts how often its bytes were fetched. */
export function doc(assetId: string, pdf: ReturnType<typeof syntheticPdf>, citedPages: number[], reads = { n: 0 }): PdfEvidenceDocument {
 return { assetId, sha256: pdf.sha256, size: pdf.size, citedPages, read: async () => { reads.n++; return pdf.bytes.slice(); } };
}
export const step = (candidateId: string, resultsVersionTag: string, documents: PdfEvidenceDocument[]) =>
 ({ clientId, caseId, candidateId, resultsVersion: rv(resultsVersionTag), documents });
