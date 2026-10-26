// SDK BOUNDARY DOUBLES ONLY. No browser, provider, workerd or PDF rendering is run by this file.
// The per-case daily ceiling is 3 and the client ceiling stays 4. A third same-case reservation needs the 0002 schema;
// the unmigrated 0001 schema refuses it. Every input here is synthetic.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import type { CloudD1, CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { createNativePreviewRenderChecker, NATIVE_PDF_RENDER_CEILINGS, type NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';

const sdk = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: sdk.launch } }));
const root = mkdtempSync(join(tmpdir(), 'clearcase-native-case-ceiling-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const BASE = 'src/lib/viewer/hosted/migrations/0001_preview_render_work.sql';
const CASE_LIMIT = 'src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql';
const DAY_MS = 86_400_000, day = 20_000, LEASE = 82_000;
const databases: DatabaseSync[] = [];
afterAll(() => databases.forEach(db => db.close()));
beforeEach(() => { sdk.launch.mockReset(); sdk.launch.mockRejectedValue(Error('inert SDK double: no browser')); });

function schema(migrated: boolean) {
 const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
 sqlite.exec('PRAGMA foreign_keys=ON');
 sqlite.exec(readFileSync(BASE, 'utf8'));
 if (migrated) { sqlite.exec('BEGIN'); sqlite.exec(readFileSync(CASE_LIMIT, 'utf8')); sqlite.exec('COMMIT'); }
 return sqlite;
}
const h = (s: string) => createHash('sha256').update(s).digest('hex');
function reserve(db: DatabaseSync, token: string, o: { client?: string; case?: string; at: number; caseLimit?: number; clientLimit?: number; lease?: number }) {
 db.prepare(`INSERT INTO npr_reservations (token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,binding_sha256,day,started_ms,lease_ms,case_limit,client_limit)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, o.client ?? 'client-b', o.case ?? 'case-b1', 'cand', 'v', 'asset', h('in'), 100, 'r', h(token),
  Math.floor(o.at / DAY_MS), o.at, o.lease ?? LEASE, o.caseLimit ?? 3, o.clientLimit ?? 4);
}
const at = (n: number) => day * DAY_MS + 1_000 + n * LEASE;

describe('the renderer ceilings: case 3, client 4, every other ceiling unchanged', () => {
 it('publishes exactly the reviewed ceilings', () => {
  expect(NATIVE_PDF_RENDER_CEILINGS).toEqual({ maxFileBytes: 4_000_000, maxPages: 8, maxCanvasPixels: 4_000_000, maxRunMs: 20_000, maxRunsPerCasePerDay: 3, maxRunsPerClientPerDay: 4 });
  expect(Object.isFrozen(NATIVE_PDF_RENDER_CEILINGS)).toBe(true);
 });
 const make = (budget: Partial<typeof NATIVE_PDF_RENDER_CEILINGS>) => createNativePreviewRenderChecker({
  db: { withSession: () => ({}) }, clientId: id('client', 'client-b'), browser: { fetch: async () => new Response('x') } as unknown as BrowserWorker,
  assets: { fetch: async () => new Response('x') }, appOrigin: 'https://app.example', pins: structuredClone(pins),
  budget: { ...NATIVE_PDF_RENDER_CEILINGS, ...budget }, now: () => new Date() } as unknown as NativePreviewRenderOptions);
 it.each([[3, 4], [3, 3], [1, 1]])('accepts case %i with client %i', async (c, k) => {
  expect(await make({ maxRunsPerCasePerDay: c, maxRunsPerClientPerDay: k })).not.toBeNull();
 });
 it.each([[4, 4], [3, 2], [2, 5]])('refuses case %i with client %i', async (c, k) => {
  expect(await make({ maxRunsPerCasePerDay: c, maxRunsPerClientPerDay: k })).toBeNull();
 });
});

describe('admission at the new boundary, on actual SQLite triggers', () => {
 it('the unmigrated 0001 schema refuses a case limit of 3 outright', () => {
  const db = schema(false);
  expect(() => reserve(db, 't1', { at: at(0) })).toThrow(/CHECK constraint failed/);
  expect(db.prepare('SELECT count(*) AS n FROM npr_reservations').get()).toEqual({ n: 0 });
 });
 it('after 0002: the third same-case run is admitted and the fourth is refused', () => {
  const db = schema(true);
  for (let i = 0; i < 3; i++) reserve(db, `t${i}`, { at: at(i) });
  expect(db.prepare('SELECT day, runs FROM npr_case_days').all()).toEqual([{ day, runs: 3 }]);
  expect(() => reserve(db, 't3', { at: at(3) })).toThrow(/case admission refused/);
  expect(db.prepare('SELECT count(*) AS n FROM npr_reservations').get()).toEqual({ n: 3 });
 });
 it('after 0002: a case limit of 4, or above the client limit, is still refused by the schema', () => {
  const db = schema(true);
  expect(() => reserve(db, 't1', { at: at(0), caseLimit: 4 })).toThrow(/CHECK constraint failed/);
  expect(() => reserve(db, 't1', { at: at(0), caseLimit: 3, clientLimit: 2 })).toThrow(/CHECK constraint failed/);
  expect(() => reserve(db, 't1', { at: at(0), clientLimit: 5 })).toThrow(/CHECK constraint failed/);
 });
 it('after 0002: the client day limit (4) and one-browser-at-a-time leases are unchanged', () => {
  const db = schema(true);
  reserve(db, 'a1', { case: 'case-1', at: at(0) });
  expect(() => reserve(db, 'a2', { case: 'case-2', at: at(1) - 1 })).toThrow(/client admission refused/);
  reserve(db, 'a2', { case: 'case-2', at: at(1) });
  reserve(db, 'a3', { case: 'case-3', at: at(2) });
  reserve(db, 'a4', { case: 'case-4', at: at(3) });
  expect(() => reserve(db, 'a5', { case: 'case-5', at: at(4) })).toThrow(/client admission refused/);
  // A smaller per-reservation client limit still binds against the day's existing runs.
  const other = schema(true);
  reserve(other, 'b1', { case: 'case-1', at: at(0), caseLimit: 2, clientLimit: 2 });
  reserve(other, 'b2', { case: 'case-1', at: at(1), caseLimit: 2, clientLimit: 2 });
  // BEFORE INSERT admission runs ahead of the row CHECKs, so the full client day refuses first.
  expect(() => reserve(other, 'b3', { case: 'case-1', at: at(2), caseLimit: 3, clientLimit: 2 })).toThrow(/client admission refused/);
  expect(() => reserve(other, 'b3', { case: 'case-2', at: at(2), caseLimit: 2, clientLimit: 2 })).toThrow(/client admission refused/);
 });
 it('after 0002: two historical case-limit-2 runs leave room for exactly one case-limit-3 run that day', () => {
  const db = schema(true);
  reserve(db, 'h1', { at: at(0), caseLimit: 2, clientLimit: 2 });
  reserve(db, 'h2', { at: at(1), caseLimit: 2, clientLimit: 2 });
  expect(() => reserve(db, 'n0', { at: at(2), caseLimit: 2, clientLimit: 3 })).toThrow(/case admission refused/);
  reserve(db, 'n1', { at: at(2), caseLimit: 3, clientLimit: 3 });
  expect(() => reserve(db, 'n2', { at: at(3), caseLimit: 3, clientLimit: 4 })).toThrow(/case admission refused/);
  expect(db.prepare('SELECT runs FROM npr_client_days').get()).toEqual({ runs: 3 });
 });
});

describe('the real checker passes the budget\'s case limit to the reservation', () => {
 function d1(sqlite: DatabaseSync) {
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
  return { withSession: (constraint: 'first-primary') => { expect(constraint).toBe('first-primary'); return primary; } };
 }
 const bytes = new TextEncoder().encode('%PDF-1.7\nSYNTHETIC CASE CEILING INPUT; NOT A RENDERABLE PDF.');
 const input = () => ({ clientId: id('client', 'client-b'), caseId: id('case', 'case-b1'), candidateId: 'cand-b1', resultsVersion: resultsVersion('sha256:' + 'a'.repeat(64)),
  assetId: 'preview-b1', mediaType: 'application/pdf', bytes: bytes.slice(), sha256: h2(bytes) });
 function h2(b: Uint8Array) { return createHash('sha256').update(b).digest('hex'); }
 async function runs(migrated: boolean, budget: Partial<typeof NATIVE_PDF_RENDER_CEILINGS>) {
  const sqlite = schema(migrated);
  let clock = at(0);
  const checker = await createNativePreviewRenderChecker({
   db: d1(sqlite), clientId: id('client', 'client-b'), browser: { fetch: async () => { throw Error('inert BROWSER double'); } } as unknown as BrowserWorker,
   assets: { fetch: async () => new Response('unused') }, appOrigin: 'https://app.example', pins: structuredClone(pins),
   budget: { ...NATIVE_PDF_RENDER_CEILINGS, ...budget }, now: () => new Date(clock) } as unknown as NativePreviewRenderOptions);
  expect(checker).not.toBeNull();
  const reasons: (string | null)[] = [];
  for (let i = 0; i < 4; i++) { clock = at(i); reasons.push((await checker!.verify(input())).reason); }
  return { reasons, limits: sqlite.prepare('SELECT case_limit, client_limit FROM npr_reservations ORDER BY started_ms').all() };
 }
 it('case 3 on the migrated schema: three reservations, then refused at admission', async () => {
  const { reasons, limits } = await runs(true, { maxRunsPerCasePerDay: 3, maxRunsPerClientPerDay: 4 });
  expect(reasons[3]).toBe('render-admission-refused');
  expect(reasons.slice(0, 3)).not.toContain('render-admission-refused');
  expect(limits).toEqual([1, 2, 3].map(() => ({ case_limit: 3, client_limit: 4 })));
 });
 it('case 3 on the unmigrated schema fails closed: no reservation, refused at admission', async () => {
  const { reasons, limits } = await runs(false, { maxRunsPerCasePerDay: 3, maxRunsPerClientPerDay: 4 });
  expect(reasons).toEqual(Array(4).fill('render-admission-refused'));
  expect(limits).toEqual([]);
 });
 it('the default case 2 budget still stops at two on the migrated schema', async () => {
  const { reasons, limits } = await runs(true, { maxRunsPerCasePerDay: 2, maxRunsPerClientPerDay: 4 });
  expect(reasons.slice(2)).toEqual(['render-admission-refused', 'render-admission-refused']);
  expect(limits).toHaveLength(2);
 });
});
