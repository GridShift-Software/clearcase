// UNIT TEST HARNESS ONLY. Counts the calls a hosted route's `load` or `GET` makes to D1, Clerk and R2 and fails above a
// budget (./budget.ts). D1 and R2 are the storage doubles of tests/hosted-foundation/storage/doubles.ts (node:sqlite and an
// in-memory bucket) behind counting proxies; every fetch during the call is a counted fetch, so a Clerk call that no
// double answers is still seen. These counts are numbers of calls, not latencies, and nothing here is evidence of Cloudflare.
//
// What `hostedWorld` leaves out, so a count is a lower bound: the identity is the storage fixture's granted identity,
// which makes no D1 or Clerk call (a route's grant query and its Clerk checks arrive with the identity that tickets 03,
// 04 and 06 land: pass theirs as `identity`), and the audit sink is a no-op.
import { DatabaseSync } from 'node:sqlite';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig } from '../../../src/lib/user-work/hosted/index.ts';
import type { CloudD1, CloudR2 } from '../../../src/lib/storage/cloud/bindings.ts';
import type { Identity, RequestServices } from '../../../src/lib/server/runtime/contracts.ts';
import { BUDGETS, QUOTAS, deployment, grantedIdentity, ids, provideOriginals, publish, syntheticPackage } from '../storage/fixture.ts';
import type { MemoryR2, SqliteD1 } from '../storage/doubles.ts';
import { MIGRATION, bind, LIMITS } from '../user-work/world.ts';
import { COUNTED, type Budget, type Counted } from './budget.ts';

export type Counts = Record<Counted, number> & {
  /** Fetches to a host that is not Clerk. No budget allows one: a page, range or mutation has no other network call. */
  otherFetch: number;
};
export interface Counters extends Counts { reset(): void; snapshot(): Counts }

export function counters(): Counters {
  const c: Counters = {
    clerk: 0, d1: 0, r2: 0, otherFetch: 0,
    reset() { c.clerk = c.d1 = c.r2 = c.otherFetch = 0; },
    snapshot: () => ({ clerk: c.clerk, d1: c.d1, r2: c.r2, otherFetch: c.otherFetch }),
  };
  return c;
}

const wrap = <T extends object>(target: T, get: (t: T, p: string | symbol) => unknown): T =>
  new Proxy(target, { get: (t, p, r) => { const v = get(t, p); return v === undefined ? Reflect.get(t, p, r) : v; } });

const STATEMENT_RUNS = new Set(['first', 'all', 'run', 'raw']);
function countedStatement<S extends object>(statement: S, c: Counters): S {
  return wrap(statement, (t, p) => {
    const v = (t as Record<string | symbol, unknown>)[p];
    if (p === 'bind' && typeof v === 'function') return (...a: unknown[]) => countedStatement(Reflect.apply(v, t, a) as object, c);
    // A statement's own `exec` is the double's batch plumbing, not a round trip: `batch` counts as one.
    if (typeof p === 'string' && STATEMENT_RUNS.has(p) && typeof v === 'function') return (...a: unknown[]) => { c.d1++; return Reflect.apply(v, t, a); };
    return undefined;
  });
}
/** `db` with every D1 round trip counted: a statement's first/all/run/raw, one per batch, and one per exec. */
export function countedD1<D extends object>(db: D, c: Counters): D {
  return wrap(db, (t, p) => {
    const v = (t as Record<string | symbol, unknown>)[p];
    if (p === 'prepare' && typeof v === 'function') return (...a: unknown[]) => countedStatement(Reflect.apply(v, t, a) as object, c);
    if ((p === 'batch' || p === 'exec') && typeof v === 'function') return (...a: unknown[]) => { c.d1++; return Reflect.apply(v, t, a); };
    return undefined;
  });
}
/** `bucket` with every R2 read counted: get, head and list. Writes are not reads and stay uncounted. */
export function countedR2<B extends object>(bucket: B, c: Counters): B {
  return wrap(bucket, (t, p) => {
    const v = (t as Record<string | symbol, unknown>)[p];
    if ((p === 'get' || p === 'head' || p === 'list') && typeof v === 'function') return (...a: unknown[]) => { c.r2++; return Reflect.apply(v, t, a); };
    return undefined;
  });
}

const CLERK_HOST = /(^|\.)clerk\.|\.clerk$|clerk\.accounts\.dev$/i;
/** A fetch that answers `{}` and counts: Clerk hosts into `clerk`, every other host into `otherFetch`. */
export function countedFetch(c: Counters): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (CLERK_HOST.test(url.hostname)) c.clerk++; else c.otherFetch++;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export type Outcome<T> = { value: T; thrown?: undefined } | { thrown: unknown; value?: undefined };
/**
 * Runs `route` (a `load`, a `GET`, any async function) with the counters reset and `fetch` replaced by the counted one,
 * and returns what it answered or threw, with the counts it made. Setup before the call is never counted.
 */
export async function measure<T>(c: Counters, route: () => Promise<T> | T): Promise<Outcome<T> & { counts: Counts }> {
  c.reset();
  const original = globalThis.fetch;
  globalThis.fetch = countedFetch(c);
  try {
    try { return { value: await route(), counts: c.snapshot() }; }
    catch (thrown) { return { thrown, counts: c.snapshot() }; }
  } finally { globalThis.fetch = original; }
}

/** The overruns of `counts` against `budget`, as `clerk: 3 calls, budget 2` lines; empty when within. */
export function overruns(counts: Counts, budget: Budget): string[] {
  const out: string[] = [];
  for (const k of COUNTED) { const limit = budget[k]; if (limit !== undefined && counts[k] > limit) out.push(`${k}: ${counts[k]} calls, budget ${limit}`); }
  if (counts.otherFetch > 0) out.push(`otherFetch: ${counts.otherFetch} calls to a host that is not Clerk, budget 0`);
  return out;
}
export class BudgetExceeded extends Error {
  counts: Counts;
  budget: Budget;
  over: string[];
  constructor(label: string, counts: Counts, budget: Budget, over: string[]) {
    super(`${label} is over its request budget (${over.join('; ')}); counted ${JSON.stringify(counts)}`);
    this.name = 'BudgetExceeded';
    this.counts = counts; this.budget = budget; this.over = over;
  }
}
/** Throws `BudgetExceeded` when `counts` is over `budget`. */
export function assertWithinBudget(label: string, counts: Counts, budget: Budget): void {
  const over = overruns(counts, budget);
  if (over.length) throw new BudgetExceeded(label, counts, budget, over);
}
/**
 * Runs `route` and asserts its counts against `budget`; the route's own refusal (a Kit `error()` or `redirect()`) is
 * returned, not thrown, so a test can assert on both. Returns the counts so a test can record them.
 */
export async function expectWithinBudget<T>(label: string, budget: Budget, c: Counters, route: () => Promise<T> | T) {
  const result = await measure(c, route);
  assertWithinBudget(label, result.counts, budget);
  return result;
}

const now = () => new Date('2001-01-01T00:00:00Z');
export interface World {
  /** What a route reads as `locals`. */
  locals: RequestServices;
  counters: Counters;
  /** The uncounted doubles, for setup. */
  db: SqliteD1;
  bucket: MemoryR2;
  caseId: typeof ids.caseA;
  /** The published results version, or null for a case with none. */
  resultsVersion: string | null;
}
/**
 * One synthetic client with one case and the real hosted storage adapters (createCloudResults, createD1UserWork) over
 * counted D1 and R2 doubles. `published: true` stages a two-document package with its originals and publishes it. Counters
 * start at zero after the seeding. Pass `identity` to measure with a different one (for example a D1-backed grant check).
 */
export async function hostedWorld(o: { published?: boolean; identity?: Identity; cases?: string[] } = {}): Promise<World> {
  const caseNames = o.cases ?? ['case-a'];
  const dep = deployment('client-a', caseNames);
  const c = counters();
  const db = countedD1(dep.db, c) as CloudD1 & SqliteD1, bucket = countedR2(dep.bucket, c) as CloudR2 & MemoryR2;
  const identity = o.identity ?? grantedIdentity(ids.clientA, caseNames).identity;
  let resultsVersion: string | null = null;
  if (o.published ?? true) {
    const pkg = await syntheticPackage('case-a', 'budget');
    await provideOriginals(dep, 'case-a', pkg);
    const staging = createResultsStaging({ bindings: { db: dep.db, bucket: dep.bucket }, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now });
    const staged = await staging.stage({ caseId: ids.caseA, operationId: 'import-1', files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection });
    if (staged.kind !== 'stored') throw new Error(`budget fixture did not stage: ${JSON.stringify(staged)}`);
    publish(dep.db, 'case-a', pkg.identity.resultsVersion);
    resultsVersion = pkg.identity.resultsVersion;
  }
  // The user-work tables live in the same D1 in production.
  (dep.db.sqlite as DatabaseSync).exec(MIGRATION);
  bind(dep.db.sqlite as DatabaseSync);
  const config = userWorkConfig({ clientId: ids.clientA, limits: LIMITS });
  const audit = { append: async (e: { eventId: string }) => ({ eventId: e.eventId }) } as RequestServices['audit'];
  const results = createCloudResults({
    bindings: { db, bucket }, clientId: ids.clientA, budgets: BUDGETS, identity, now, record: async () => {},
    stateRevision: d1WorkRevision({ db: db as never, config }),
    viewerRoute: (asset) => asset.kind === 'original' ? `/cases/${encodeURIComponent(asset.caseId)}/originals/${encodeURIComponent(asset.assetId)}/view` : null,
  });
  const userWork = createD1UserWork({ db: db as never, config, identity, audit, store: results.store, now, tableDefinitions: null });
  c.reset();
  const locals = { identity, store: results.store, assets: results.assets, userWork, audit, runtime: { now } } as unknown as RequestServices;
  return { locals, counters: c, db: dep.db, bucket: dep.bucket, caseId: ids.caseA, resultsVersion };
}

/** A SvelteKit event with just what a `load` or `GET` reads. */
export const routeEvent = (locals: RequestServices, params: Record<string, string> = {}, url = 'https://client-a.example.invalid/cases', init?: RequestInit) =>
  ({ locals, params, url: new URL(url), request: new Request(url, init) }) as never;
