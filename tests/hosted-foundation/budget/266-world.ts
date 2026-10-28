// The RC latency paths (GRS-266) through the real hostedServices composition, as 16-note-save.test.ts builds it: the case
// notes list, the bundle save POST and the bundle page loads. Every D1 round trip is counted, batches apart, and each D1
// call can be held for a fixed delay so the elapsed time over that delay gives the round trips on the critical path.
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

/** Each D1 call waits this long before it runs, so `elapsed / DELAY_MS` is the round trips one after another. */
export const DELAY_MS = 20;
export const R2_PUT_DELAYS = 6;

export const SHARDS = {
  'view/court_bundle_tab.json': { pathShard: { paths: {} }, bundles: [], links: [], header: {} },
  'view/discovery_tab.json': { pathShard: { paths: {} }, present: true, schedules: { discovery: [], supplementary: [] }, files: {}, downloads: {}, caption: {}, meta: {}, mode: 'discovery', selected: [], marks: [] },
} as const;

export async function rcWorld() {
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
  const wait = () => delay ? new Promise(r => setTimeout(r, delay)) : Promise.resolve();
  const slowStatement = (s: object): object => new Proxy(s, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'bind' && typeof v === 'function') return (...a: unknown[]) => slowStatement(Reflect.apply(v, t, a) as object);
    if ((p === 'first' || p === 'all' || p === 'run' || p === 'raw') && typeof v === 'function') return async (...a: unknown[]) => { await wait(); return Reflect.apply(v, t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const slow = new Proxy(raw, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'prepare') return (...a: unknown[]) => { if (process.env.RC_SQL) console.log('[DEBUG-rc266]', String(a[0]).replace(/\s+/g, ' ').slice(0, 110)); return slowStatement(t.prepare(...a)); };
    if (p === 'batch') return async (s: unknown[]) => { batches++; await wait(); return t.batch(s); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const db = countedD1(slow, w.counters), pending: Promise<void>[] = [];
  // An R2 put is held as long as R2_PUT_DELAYS D1 calls, about staging's ratio (250 ms against 40 ms).
  const bucket = countedR2(new Proxy(w.bucket, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === 'put') return async (...a: unknown[]) => { if (delay) await new Promise(r => setTimeout(r, delay * R2_PUT_DELAYS)); return Reflect.apply(v, t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } }), w.counters);
  const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: bucket,
    CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} } });
  workers.env = env;
  const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
  const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
  const session = await mintAppSession(config, { sid: 'synthetic-rc-session', subject: 'rc-editor', name: 'Synthetic Editor' });
  const cookie = `clearcase_session=${await signAppSession(config, session)}`;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('rc-grant','client-a','case','case-a',?,'rc-editor','client','editor','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
  const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  await provisionAuditBinding({ db, config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [issuer, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
  const base = `${origin}/cases/case-a`;
  /** The request's services, as hooks build them for `path`, then `route` over them; counted from the services on. */
  async function request<T>(path: string, init: RequestInit, route: (locals: RequestServices, request: Request, url: URL) => Promise<T>) {
    const url = new URL(base + path), req = new Request(url, { ...init, headers: { cookie, origin, ...(init.headers as Record<string, string> | undefined) } });
    return measure(w.counters, async () => {
      const ready = await hostedServices(req, env, { waitUntil: p => pending.push(p) });
      if (!ready.ready) throw new Error(`services not ready: ${ready.reason}`);
      return route(ready.services, req, url);
    });
  }
  /** `request` with every D1 call delayed: its counts, batches and the critical-path round trips. */
  async function timed<T>(path: string, init: RequestInit, route: (locals: RequestServices, request: Request, url: URL) => Promise<T>) {
    delay = DELAY_MS; batches = 0;
    const start = performance.now();
    try {
      const result = await request(path, init, route);
      const sequential = Math.round((performance.now() - start) / DELAY_MS);
      return { ...result, batches, sequential };
    } finally { delay = 0; await Promise.all(pending.splice(0)); }
  }
  return { ...w, rv, base, origin, request, timed, pending, batches: () => batches,
    async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}
export type RcWorld = Awaited<ReturnType<typeof rcWorld>>;
export const show = (label: string, r: { counts: Counts; batches?: number; sequential?: number }) =>
  console.log(`266 ${label}: d1=${r.counts.d1} r2=${r.counts.r2} clerk=${r.counts.clerk} batches=${r.batches ?? '-'} sequential≈${r.sequential ?? '-'}`);
