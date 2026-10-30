// Synthetic worlds for sprint ticket 06: a v5-shaped package with more than one list page built into shards by
// scripts/publish/build.ts, and one client deployment (node:sqlite behind D1's shape, an in-memory bucket) that
// `register`, `signoff` and `publish` write to, read by the real hosted reader and shard reader. Nothing here is a case.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCase, row, type SynthCase } from '../../e2e/pilot/lib/fixtures.ts';
import { build, shardsOut, type Built } from '../../../scripts/publish/build.ts';
import type { D1Exec } from '../../../scripts/publish/d1.ts';
import { MANIFEST_NAME } from '../../../scripts/publish/manifest.ts';
import { publish, register } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
import { upload, type RemoteState, type ShardRemote } from '../../../scripts/publish/upload.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import type { ClientResourceIdentity } from '../../../src/lib/tenancy/manifest.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { CODES } from '../../../src/lib/case-package/codes.ts';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { createShardReader, shardPrefix, type ShardBucket, type ShardCache } from '../../../src/lib/results/hosted/shards.ts';
import type { CloudD1, CloudR2 } from '../../../src/lib/storage/cloud/bindings.ts';
import type { CaseId, Identity, RequestServices } from '../../../src/lib/server/runtime/contracts.ts';
import { memoryShardBucket, memoryShardCache } from '../../../src/lib/server/runtime/memory-shards.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig } from '../../../src/lib/user-work/hosted/index.ts';
import { BUDGETS, deployment, grantedIdentity, ids } from '../../hosted-foundation/storage/fixture.ts';
import type { MemoryR2, SqliteD1 } from '../../hosted-foundation/storage/doubles.ts';
import { bind, LIMITS, MIGRATION } from '../../hosted-foundation/user-work/world.ts';

export const CASE_ID = 'synth-shards';
export const EXTRA_ROWS = 230;
export const SIGNER = 'operator@example.invalid';
const SHARD_MIGRATIONS = ['0006_shard_publication.sql', '0007_shard_admission.sql']
  .map((f) => readFileSync(new URL(`../../../src/lib/publication/hosted/migrations/${f}`, import.meta.url), 'utf8'));
const migration = (p: string) => readFileSync(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => new Date('2001-01-01T00:00:00Z');

export interface BuiltCase { root: string; out: string; synth: SynthCase; built: Built; files: Map<string, Uint8Array>; cleanup(): Promise<void> }

/** The synthetic package (its own rows plus EXTRA_ROWS invented PDFs), built into `<root>/out`. */
export async function builtCase({ duplicateBulkOriginals = false }: { duplicateBulkOriginals?: boolean } = {}): Promise<BuiltCase> {
  const root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-shards-'));
  const originals: Record<string, Uint8Array> = {}, rows = [];
  for (let i = 0; i < EXTRA_ROWS; i++) {
    const file = `BULK/BK-${String(i).padStart(4, '0')} Synthetic.pdf`, bytes = enc(`%PDF-1.4\n% synthetic bulk ${duplicateBulkOriginals && i === 1 ? 0 : i}\n%%EOF\n`);
    originals[file] = bytes;
    rows.push(row(`BK-${String(i).padStart(4, '0')}`, 1000 + i, file, bytes.byteLength, { date: `${2000 + (i % 5)}-01-0${1 + (i % 9)}`, bundle: i % 2 ? 'Bulk A' : 'Bulk B' }));
  }
  const synth = await buildCase(path.join(root, 'case'), { caseId: CASE_ID, originals, rows });
  const out = path.join(root, 'out');
  const built = await build({ packageDir: synth.pkgDir, caseFolder: synth.caseDir, caseId: CASE_ID, out, builder: { sha: 'test', bun: 'test' }, now });
  return { root, out, synth, built, files: await shardFiles(shardsOut(out)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Every file under the shards directory, by its name relative to it. */
export async function shardFiles(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, full).split(path.sep).join('/'), new Uint8Array(await readFile(full)));
  }
  return out;
}

/** `wrangler d1 execute`'s two calls over the SQLite double. */
export const sqliteExec = (db: SqliteD1): D1Exec => ({
  async file(sql) { db.sqlite.exec(sql); },
  async all<T>(sql: string) { return db.sqlite.prepare(sql).all() as T[]; },
});

const WARNING = new Set(Object.entries(CODES).filter(([, d]) => d.severity === 'warning').map(([c]) => c));
/** The acknowledgement arguments `signoff` needs for this build: one per warning code. */
export const acksFor = (b: Built): string[] => Object.entries(b.record.diagnostics).filter(([code, n]) => n > 0 && WARNING.has(code)).map(([code]) => `${code}=synthetic fixture`);

/** The fixture's own missing originals (the synthetic case leaves one out on purpose): what `register` is told to accept. */
export const missing = (b: Built) => b.record.diagnostics.ASSET_MISSING_AT_BUILD ?? 0;

/** The client's D1 (`db`, with `d1` the CLI's view of it), its storage bucket (`r2`) and the shard objects (`bucket`). */
export interface Deployment { db: SqliteD1; d1: D1Exec; r2: MemoryR2; bucket: ReturnType<typeof memoryShardBucket> }

/** One client deployment with the case provisioned and the shard migrations applied, nothing registered. */
export function client(): Deployment {
  const dep = deployment('client-a', [CASE_ID]);
  for (const m of SHARD_MIGRATIONS) dep.db.sqlite.exec(m);
  return { db: dep.db, d1: sqliteExec(dep.db), r2: dep.bucket, bucket: memoryShardBucket() };
}

/** `rclone` against the bucket double: the same three calls over `views/<rvHex>/` objects, bytes compared exactly. */
export function memoryRemote(objects: Map<string, Uint8Array>, resultsVersion: string): ShardRemote & { created: string[] } {
  const prefix = shardPrefix(resultsVersion), created: string[] = [];
  const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
  return {
    created,
    async compare(dir, names) {
      const out = new Map<string, RemoteState>();
      for (const n of names) {
        const there = objects.get(prefix + n);
        out.set(n, !there ? 'absent' : same(there, new Uint8Array(await readFile(path.join(dir, n)))) ? 'same' : 'differs');
      }
      return out;
    },
    async create(dir, names) {
      for (const n of names) if (!objects.has(prefix + n)) { objects.set(prefix + n, new Uint8Array(await readFile(path.join(dir, n)))); created.push(n); }
    },
    async read(name) { const b = objects.get(prefix + name); return b ? new Uint8Array(b) : null; },
  };
}

export const AT = '2001-01-01T00:00:00.000Z';
export const manifestOf = (b: BuiltCase) => b.files.get(MANIFEST_NAME)!;

/** Uploads the shards (the bucket double) and runs register, signoff and publish. */
export async function published(b: BuiltCase, dep: Deployment = client()): Promise<Deployment> {
  const r = b.built.record;
  await upload({ dir: shardsOut(b.out), index: MANIFEST_NAME, remote: memoryRemote(dep.bucket.objects, r.resultsVersion) });
  await register(dep.d1, r, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifestOf(b) });
  await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
  await publish(dep.d1, r, { remoteManifest: dep.bucket.objects.get(shardPrefix(r.resultsVersion) + MANIFEST_NAME) ?? null, at: AT });
  return dep;
}

/**
 * The production authority over the deployment's D1: the real case authorizer (grant query, case directory, audit append),
 * built per authorize call as hosted/services.ts does, for a principal holding `viewer` on the case. `db` is the D1 it
 * queries (a budget test passes a counted one). Counts the authorize calls.
 */
export async function realAuthority(dep: Deployment, db: CloudD1 = dep.db) {
  const deployment = { clientId: ids.clientA, hostname: 'client-a.example.invalid', worker: 'client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'client-a',
    r2Bucket: 'client-a', clientIssuer: 'https://clerk.client-a.example.invalid', staffIssuer: 'https://clerk.staff.example.invalid' } as ClientResourceIdentity;
  const principal = { issuer: deployment.clientIssuer, subject: 'synthetic-viewer', kind: 'client' as const }, sessionId = id('session', 'synthetic-session');
  const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer],
    limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 10_000, maxDenialsPerActor: 1000, maxPageRows: 50, maxPagesPerRequest: 5 } });
  if (!dep.db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tenant_case_grants'").get()) {
    for (const p of ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql', 'audit/migrations/0001_native_audit.sql']) dep.db.sqlite.exec(migration(p));
    await provisionAuditBinding({ db: dep.db as never, config, now });
    dep.db.sqlite.prepare(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
      VALUES ('g-viewer', ?, 'case', ?, ?, ?, 'client', 'viewer', 'content', 'active', 1, 'grant-op', '{}', ?, 'provisioner', ?)`).run(ids.clientA, CASE_ID, principal.issuer, principal.subject, deployment.staffIssuer, now().toISOString());
  }
  const requester = { kind: 'verified' as const, principal, sessionId };
  const audit = requestAuditSink({ db: db as never, config, requester, now });
  const counted = { authorizations: 0 };
  const identity: Identity = { ...requester, clientId: ids.clientA, async checkRevocation() {},
    async authorize(q) {
      counted.authorizations++;
      const authorizer = createCaseAuthorizer({ deployment, grants: d1GrantRepository(db as never), cases: d1CaseDirectory({ db: db as never, deployment }),
        audit: requestAuditSink({ db: db as never, config, requester, now }), now });
      await authorizer.authorizeCase({ ...q, principal, sessionId });
    } };
  return { identity, audit, counted };
}

/**
 * What a hosted route reads as `locals`, over the deployment: the real reader, user work and shard reader. `db`, `r2` and
 * `bucket` replace the deployment's own (a budget test passes counted ones).
 */
export function locals(dep: Deployment, o: { identity?: Identity; audit?: RequestServices['audit']; db?: CloudD1; r2?: CloudR2; bucket?: ShardBucket; cache?: ShardCache | null } = {}): RequestServices {
  const identity = o.identity ?? grantedIdentity(ids.clientA, [CASE_ID]).identity;
  const db = o.db ?? dep.db;
  if (!dep.db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'uw_binding'").get()) { dep.db.sqlite.exec(MIGRATION); bind(dep.db.sqlite); }
  const config = userWorkConfig({ clientId: ids.clientA, limits: LIMITS });
  const audit = o.audit ?? { append: async (e: { eventId: string }) => ({ eventId: e.eventId }) } as RequestServices['audit'];
  const results = createCloudResults({ bindings: { db, bucket: o.r2 ?? dep.r2 }, clientId: ids.clientA, budgets: BUDGETS, identity, now,
    // As hosted/services.ts records a storage event: into the request's audit sink.
    record: async (event) => { await audit.append({ ...event, eventId: crypto.randomUUID(), at: now().toISOString(),
      actor: identity.kind === 'verified' ? { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null } } as never); },
    stateRevision: d1WorkRevision({ db: db as never, config }) });
  const userWork = createD1UserWork({ db: db as never, config, identity, audit, store: results.store, now, tableDefinitions: null });
  const shards = createShardReader({ bucket: o.bucket ?? dep.bucket, clientId: ids.clientA, cache: o.cache === undefined ? memoryShardCache() : o.cache });
  return { identity, store: results.store, assets: results.assets, userWork, audit, runtime: { now }, shards } as unknown as RequestServices;
}
export const caseId = CASE_ID as CaseId;
