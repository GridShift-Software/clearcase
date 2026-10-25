// Synthetic transport faults at the real factory's two public ports, not provider evidence.
import { afterEach, describe, expect, it } from 'vitest';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { caseId, world } from './world.ts';
import { ids } from '../storage/fixture.ts';

type World = ReturnType<typeof world>;
type Port = 'stage' | 'files';
type Timing = 'sync' | 'async';
const ports = ['stage', 'files'] as const;
const timings = ['sync', 'async'] as const;
const faults = ['raw', 'driver-code', 'denial-code', 'contract-shaped'] as const;
type Fault = typeof faults[number];
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });
function fault(kind: Fault) {
  const error = new Error('synthetic backend fault');
  if (kind === 'driver-code') return Object.assign(error, { code: 'ECONNRESET' });
  if (kind === 'denial-code') return Object.assign(error, { code: 'forbidden' });
  // Even the full public ContractError shape cannot establish provenance at a raw driver boundary.
  if (kind === 'contract-shaped') return Object.assign(error, { code: 'integrity', retryable: false });
  return error;
}
async function prepared(port: Port) {
  const w = world(undefined, true); worlds.push(w);
  const revision = await w.upload(), a = await w.request(revision);
  if (port === 'files') await w.linked(revision);
  const args = { clientId: ids.clientA, caseId, resultsVersion: a.identity.resultsVersion };
  return { w, a, call: () => port === 'stage' ? w.ports.stager.stage(a) : w.ports.packages.files(args) };
}

const version = /^SELECT \* FROM rs_results_version WHERE version_id = \? AND case_id = \?/;
type DbSite = 'version-before' | 'files-all' | 'version-after' | 'release-version' | 'release-current' | 'prepare' | 'bind' | 'batch-prepare' | 'batch-bind' | 'run' | 'batch' | 'identity';
function injectDb(w: World, site: DbSite, timing: Timing, fail: () => never) {
  let hits = 0, audited = false;
  w.state.onAudit = () => { audited = true; };
  const prepare = w.db.prepare.bind(w.db), batch = w.db.batch.bind(w.db);
  const target = (sql: string) => site === 'identity' ? /FROM rs_storage_identity/.test(sql)
    : site === 'batch-prepare' || site === 'batch-bind' ? /^INSERT INTO rs_results_version/.test(sql)
    : site === 'files-all' ? /^SELECT path, sha256, size, object_key FROM rs_package_file/.test(sql)
    : site === 'run' ? /^DELETE FROM rs_verification_work/.test(sql)
    : site === 'release-current' ? audited && /native_candidate/.test(sql) : version.test(sql);
  const nth = site === 'version-after' ? 2 : site === 'release-version' ? 3 : 1;
  function fire() { if (++hits === nth) fail(); }
  // Ordinary (non-async) invocation is essential: an async fake would hide synchronous driver throws.
  function invoke<T>(work: () => Promise<T>): Promise<T> {
    if (timing === 'async') return Promise.resolve().then(() => { fire(); return work(); });
    fire(); return work();
  }
  w.db.prepare = (sql) => {
    if (!target(sql)) return prepare(sql);
    if (site === 'prepare' || site === 'batch-prepare') fire();
    function wrap(s: CloudD1Statement): CloudD1Statement {
      return {
        bind: (...values) => { if (site === 'bind' || site === 'batch-bind') fire(); return wrap(s.bind(...values)); },
        first: <T>() => site === 'prepare' || site === 'bind' ? s.first<T>() : invoke(() => s.first<T>()),
        all: <T>() => site === 'prepare' || site === 'bind' ? s.all<T>() : invoke(() => s.all<T>()),
        run: () => site === 'prepare' || site === 'bind' ? s.run() : invoke(() => s.run()),
      };
    }
    return wrap(prepare(sql));
  };
  if (site === 'batch') w.db.batch = (ss) => invoke(() => batch(ss));
  return () => hits >= nth;
}
async function storageFailure(w: World, call: () => Promise<unknown>, hit: () => boolean) {
  await expect(call()).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
  expect(hit()).toBe(true);
  expect(w.events.at(-1)?.outcome).toBe('failed');
  expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
}
const dbCases = ports.flatMap((port) => {
  const sites: DbSite[] = ['version-before', 'files-all', 'version-after', port === 'stage' ? 'release-version' : 'release-current', 'prepare', 'bind', 'run', 'identity', ...(port === 'stage' ? ['batch', 'batch-prepare', 'batch-bind'] as const : [])];
  return sites.flatMap((site) => (['prepare', 'bind', 'batch-prepare', 'batch-bind'].includes(site) ? ['sync'] as const : timings)
    .flatMap((timing) => faults.map((kind) => ({ port, site, timing, kind }))));
});

describe('scoped D1 invocation normalization', () => {
  it.each(dbCases)('$port $site $timing $kind is retryable storage-unavailable', async ({ port, site, timing, kind }) => {
    const { w, call } = await prepared(port);
    const hit = injectDb(w, site, timing, () => { throw fault(kind); });
    await storageFailure(w, call, hit);
  });
});

type R2Site = 'get' | 'body' | 'metadata' | 'head' | 'put' | 'head-metadata' | 'put-metadata';
const r2Cases = ports.flatMap((port) => (['get', 'body', 'metadata', ...(port === 'stage' ? ['head', 'put', 'head-metadata', 'put-metadata'] : [])] as R2Site[])
  .flatMap((site) => (site.endsWith('metadata') ? ['sync'] as const : timings)
    .flatMap((timing) => faults.map((kind) => ({ port, site, timing, kind })))));
describe('scoped R2 invocation normalization', () => {
  it.each(r2Cases)('$port $site $timing $kind is retryable storage-unavailable', async ({ port, site, timing, kind }) => {
    const { w, call } = await prepared(port);
    const get = w.bucket.get.bind(w.bucket), head = w.bucket.head.bind(w.bucket), put = w.bucket.put.bind(w.bucket);
    let hit = false;
    const fail = (): never => { hit = true; throw fault(kind); };
    function invoke(): Promise<never> {
      if (timing === 'async') return Promise.resolve().then(() => fail());
      return fail();
    }
    w.bucket.get = (key) => {
      if (key.startsWith('pkg/') && site === 'get') return invoke();
      return get(key).then((body) => {
        if (!body || !key.startsWith('pkg/')) return body;
        if (site === 'metadata') return { ...body, get size(): number { return fail(); } };
        if (site === 'body') return { ...body, arrayBuffer: () => invoke() };
        return body;
      });
    };
    w.bucket.head = (key) => key.startsWith('pkg/') && site === 'head' ? invoke() : head(key).then((h) =>
      h && key.startsWith('pkg/') && site === 'head-metadata' ? { ...h, get checksums(): typeof h.checksums { return fail(); } } : h);
    w.bucket.put = (key, bytes, options) => key.startsWith('pkg/') && site === 'put' ? invoke() : put(key, bytes, options).then((h) =>
      h && key.startsWith('pkg/') && site === 'put-metadata' ? { ...h, get size(): number { return fail(); } } : h);
    await storageFailure(w, call, () => hit);
  });
});

describe('contract provenance and authority precedence', () => {
  it.each(ports.flatMap((port) => ['get', 'body'].flatMap((site) => timings.flatMap((timing) =>
    ['forbidden', 'invalid-session'].map((code) => ({ port, site, timing, code }))))))(
    '$port R2 $site $timing fault cannot mask current $code', async ({ port, site, timing, code }) => {
      const { w, call } = await prepared(port), get = w.bucket.get.bind(w.bucket);
      let hit = false;
      function fail(): Promise<never> {
        const fire = () => {
          hit = true;
          if (code === 'forbidden') w.state.allowed = false; else w.state.revoked = true;
          throw fault('denial-code');
        };
        if (timing === 'async') return Promise.resolve().then(fire);
        return fire();
      }
      w.bucket.get = (key) => {
        if (site === 'get' && key.startsWith('pkg/')) return fail();
        return get(key).then((body) => body && site === 'body' && key.startsWith('pkg/') ? { ...body, arrayBuffer: fail } : body);
      };
      await expect(call()).rejects.toMatchObject({ code, retryable: false });
      expect(hit).toBe(true);
      expect(w.events.at(-1)?.outcome).toBe('denied');
      expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    });

  it.each(ports.flatMap((port) => ['prepare', 'bind', 'version-before'].flatMap((site) =>
    ['forbidden', 'invalid-session'].flatMap((code) => faults.map((kind) => ({ port, site: site as DbSite, code, kind }))))))(
    '$port $site $kind fault cannot mask current $code', async ({ port, site, code, kind }) => {
      const { w, call } = await prepared(port);
      const hit = injectDb(w, site, 'sync', () => {
        if (code === 'forbidden') w.state.allowed = false; else w.state.revoked = true;
        throw fault(kind);
      });
      await expect(call()).rejects.toMatchObject({ code, retryable: false });
      expect(hit()).toBe(true);
      expect(w.events.at(-1)?.outcome).toBe('denied');
      expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    });

  it.each(ports.flatMap((port) => ['operate', 'session', 'audit', 'clock'].map((source) => ({ port, source }))))(
    '$port preserves errors from $source rather than normalizing unrelated code', async ({ port, source }) => {
      const { w, a } = await prepared(port), error = new Error('synthetic non-storage defect');
      const config = { ...w.config };
      if (source === 'operate') config.authorizeOperate = async () => { throw error; };
      if (source === 'session' && w.identity.kind === 'verified') config.identity = { ...w.identity, checkRevocation: async () => { throw error; } };
      if (source === 'audit') config.audit = { append: async () => { throw error; } };
      if (source === 'clock') config.now = () => { throw error; };
      const p = createHostedCandidateStager(config);
      const call = () => port === 'stage' ? p.stager.stage(a) : p.packages.files({ clientId: ids.clientA, caseId, resultsVersion: a.identity.resultsVersion });
      await expect(call()).rejects.toBe(error);
    });

  it.each(ports)('%s retries a transient readback fault without rewriting storage or refunding work', async (port) => {
    const { w, a, call } = await prepared(port), prepare = w.db.prepare.bind(w.db);
    const plan = () => w.db.rows<{ objects: number; bytes: number }>('SELECT objects, bytes FROM rs_verification_work')[0];
    const before = plan();
    const hit = injectDb(w, 'version-after', 'sync', () => { throw fault('denial-code'); });
    await storageFailure(w, call, hit);
    const stored = w.db.rows('SELECT * FROM rs_results_version'), spent = plan();
    expect(stored).toHaveLength(1);
    expect(spent.objects).toBeGreaterThan(before?.objects ?? 0);
    expect(spent.bytes).toBeGreaterThan(before?.bytes ?? 0);
    w.db.prepare = prepare;
    const recovered = await call();
    if (port === 'stage') expect(recovered).toMatchObject({ kind: 'staged', repeated: true });
    else expect(recovered).toEqual(a.files);
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual(stored);
    expect(plan().objects).toBeGreaterThan(spent.objects);
    expect(plan().bytes).toBeGreaterThan(spent.bytes);
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  });

  it.each(ports)('%s retains an actual authority ContractError by identity after a driver fault', async (port) => {
    const { w, a } = await prepared(port), denial = contractError('forbidden');
    let deny = false;
    const p = createHostedCandidateStager({ ...w.config, authorizeOperate: async () => { if (deny) throw denial; } });
    const hit = injectDb(w, 'version-before', 'async', () => { deny = true; throw fault('driver-code'); });
    const call = () => port === 'stage' ? p.stager.stage(a) : p.packages.files({ clientId: ids.clientA, caseId, resultsVersion: a.identity.resultsVersion });
    await expect(call()).rejects.toBe(denial);
    expect(hit()).toBe(true);
    expect(w.events.at(-1)?.outcome).toBe('denied');
  });
});
