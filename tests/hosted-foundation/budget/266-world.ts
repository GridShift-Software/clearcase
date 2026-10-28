// The RC latency paths (GRS-266) through the real hostedServices composition, as 16-note-save.test.ts builds it: the case
// notes list, the bundle save POST and the bundle page loads. Every D1 round trip is counted, batches apart, and each D1
// call can be held for a fixed delay; `serial` counts the delayed calls on the critical path (`sequential` is the elapsed time over
// that delay, for 269, which keeps it beside exact call counts).
// Synthetic SQLite and in-memory doubles, not a deployed Worker.
import { vi } from 'vitest';
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { shardPrefix } from '../../../src/lib/results/hosted/shards.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../native-runtime-config/harness.ts';
import { hostedWorld, countedD1, countedR2, measure, type Counts } from './harness.ts';
import { MIGRATION } from '../provisioning/world.ts';
import type { RequestServices } from '../../../src/lib/server/runtime/contracts.ts';

/** Each D1 call waits this long before it runs, so `elapsed / DELAY_MS` is the round trips one after another. Long
 * enough that a loaded test run (the full suite in parallel) adds well under one unit. */
export const DELAY_MS = 50;
export const R2_PUT_DELAYS = 6;

export const SHARDS = {
  'view/court_bundle_tab.json': { pathShard: { paths: {} }, bundles: [], links: [], header: {} },
  'view/discovery_tab.json': { pathShard: { paths: {} }, present: true, schedules: { discovery: [], supplementary: [] }, files: {}, downloads: {}, caption: {}, meta: {}, mode: 'discovery', selected: [], marks: [] },
} as const;

/** `slowReads` also holds every KV get and R2 get or head for one D1 delay, so `serial` and `sequential` count those round trips too. */
export async function rcWorld(o: { slowReads?: boolean } = {}) {
  const w = await hostedWorld();
  w.db.sqlite.exec(MIGRATION);
  w.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
  const rv = w.resultsVersion!;
  const admitted: Record<string, number> = {};
  for (const [name, payload] of Object.entries(SHARDS)) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    await w.bucket.put(shardPrefix(rv) + name, bytes, { sha256: createHash('sha256').update(bytes).digest('hex') });
    admitted[name] = bytes.byteLength;
  }
  w.db.exec('INSERT INTO rs_shard_manifest (version_id, prefix, manifest_sha256, built_at, admitted_json) VALUES (?, ?, ?, ?, ?)',
    rv, shardPrefix(rv), 'b'.repeat(64), '2001-01-01T00:00:00.000Z', JSON.stringify(admitted));
  const file = planNativeRuntimeConfig(exampleInput()).clients.find(c => c.clientId === 'client-a')!;
  let delay = 0, batches = 0;
  const raw = w.db as unknown as { prepare: (...a: unknown[]) => object; batch: (s: unknown[]) => Promise<unknown> };
  // `serial` counts the delayed calls one after another, not the elapsed time: a call that starts once the longest chain
  // so far has finished extends it by its own units, a call that starts beside it does not. A loaded runner stretches the
  // time between calls, not this count. `settled` is the longest finished chain, in D1-call units.
  let settled = 0;
  const wait = async (units = 1) => {
    if (!delay) return;
    const from = settled;
    await new Promise(r => setTimeout(r, delay * units));
    settled = Math.max(settled, from + units);
  };
  const slowStatement = (s: object): object => new Proxy(s, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'bind' && typeof v === 'function') return (...a: unknown[]) => slowStatement(Reflect.apply(v, t, a) as object);
    if ((p === 'first' || p === 'all' || p === 'run' || p === 'raw') && typeof v === 'function') return async (...a: unknown[]) => { await wait(); return Reflect.apply(v, t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const slow = new Proxy(raw, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'prepare') return (...a: unknown[]) => slowStatement(t.prepare(...a));
    if (p === 'batch') return async (s: unknown[]) => { batches++; await wait(); return t.batch(s); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const db = countedD1(slow, w.counters), pending: Promise<void>[] = [];
  // An R2 put is held as long as R2_PUT_DELAYS D1 calls, about staging's ratio (250 ms against 40 ms), or until a test
  // releases the put it holds (`holdPut`).
  let held: { reached: () => void; released: Promise<void> } | null = null;
  const bucket = countedR2(new Proxy(w.bucket, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'put') return async (...a: unknown[]) => {
      if (held) { held.reached(); await held.released; }
      await wait(R2_PUT_DELAYS);
      return Reflect.apply(v, t, a);
    };
    if (o.slowReads && (p === 'get' || p === 'head')) return async (...a: unknown[]) => { await wait(); return Reflect.apply(v, t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } }), w.counters);
  const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: bucket,
    CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => { if (o.slowReads) await wait(); return null; }, put: async () => {} } });
  workers.env = env;
  const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
  const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
  const session = await mintAppSession(config, { sid: 'synthetic-rc-session', subject: 'rc-editor', name: 'Synthetic Editor' });
  const cookie = `clearcase_session=${await signAppSession(config, session)}`;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('rc-grant','client-a','case','case-a',?,'rc-editor','client','editor','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
  const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  await provisionAuditBinding({ db: db as unknown as Parameters<typeof provisionAuditBinding>[0]['db'], config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [issuer, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
  const base = `${origin}/cases/case-a`;
  /** The request's services, as hooks build them for `path` (under the case, or an absolute URL), then `route` over them; counted from the services on. */
  async function request<T>(path: string, init: RequestInit, route: (locals: RequestServices, request: Request, url: URL) => Promise<T>) {
    const url = new URL(path.startsWith('/') ? base + path : path), req = new Request(url, { ...init, headers: { cookie, origin, ...(init.headers as Record<string, string> | undefined) } });
    return measure(w.counters, async () => {
      const ready = await hostedServices(req, env, { waitUntil: p => pending.push(p) });
      if (!ready.ready) throw new Error(`services not ready: ${ready.reason}`);
      return route(ready.services, req, url);
    });
  }
  /** `request` with every D1 call delayed: its counts, batches and the critical-path round trips. */
  async function timed<T>(path: string, init: RequestInit, route: (locals: RequestServices, request: Request, url: URL) => Promise<T>) {
    delay = DELAY_MS; batches = 0; settled = 0;
    const start = performance.now();
    try {
      const result = await request(path, init, route);
      const sequential = Math.round((performance.now() - start) / DELAY_MS);
      return { ...result, batches, sequential, serial: settled };
    } finally { delay = 0; await Promise.all(pending.splice(0)); }
  }
  /** Holds the next R2 puts until `release()`; `reached` resolves once one is waiting. */
  function holdPut() {
    let reached!: () => void, release!: () => void;
    const hit = new Promise<void>(r => { reached = r; }), released = new Promise<void>(r => { release = r; });
    held = { reached, released };
    return { reached: hit, release: () => { held = null; release(); } };
  }
  return { ...w, rv, base, origin, request, timed, holdPut, pending, batches: () => batches,
    async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}
export type RcWorld = Awaited<ReturnType<typeof rcWorld>>;
export const show = (label: string, r: { counts: Counts; batches?: number; sequential?: number; serial?: number }) =>
  console.log(`266 ${label}: d1=${r.counts.d1} r2=${r.counts.r2} clerk=${r.counts.clerk} batches=${r.batches ?? '-'} serial=${r.serial ?? '-'} elapsed≈${r.sequential ?? '-'}`);
