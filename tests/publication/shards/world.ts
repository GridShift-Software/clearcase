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
import { publish, register } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
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
const SHARD_MIGRATION = readFileSync(new URL('../../../src/lib/publication/hosted/migrations/0006_shard_publication.sql', import.meta.url), 'utf8');
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => new Date('2001-01-01T00:00:00Z');

export interface BuiltCase { root: string; out: string; synth: SynthCase; built: Built; files: Map<string, Uint8Array>; cleanup(): Promise<void> }

/** The synthetic package (its own rows plus EXTRA_ROWS invented PDFs), built into `<root>/out`. */
export async function builtCase(): Promise<BuiltCase> {
  const root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-shards-'));
  const originals: Record<string, Uint8Array> = {}, rows = [];
  for (let i = 0; i < EXTRA_ROWS; i++) {
    const file = `BULK/BK-${String(i).padStart(4, '0')} Synthetic.pdf`, bytes = enc(`%PDF-1.4\n% synthetic bulk ${i}\n%%EOF\n`);
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

/** One client deployment with the case provisioned and the shard migration applied, nothing registered. */
export function client(): Deployment {
  const dep = deployment('client-a', [CASE_ID]);
  dep.db.sqlite.exec(SHARD_MIGRATION);
  return { db: dep.db, d1: sqliteExec(dep.db), r2: dep.bucket, bucket: memoryShardBucket() };
}

/** Uploads the shards (the bucket double) and runs register, signoff and publish. */
export async function published(b: BuiltCase, dep: Deployment = client()): Promise<Deployment> {
  for (const [name, bytes] of b.files) dep.bucket.objects.set(shardPrefix(b.built.record.resultsVersion) + name, bytes);
  const at = '2001-01-01T00:00:00.000Z';
  await register(dep.d1, b.built.record, { at, acknowledgedMissing: missing(b.built) });
  await signoff(dep.d1, b.built.record, { signer: SIGNER, acks: acksFor(b.built), at });
  await publish(dep.d1, b.built.record, { remoteManifest: b.files.get('manifest.json')!, at });
  return dep;
}

/**
 * What a hosted route reads as `locals`, over the deployment: the real reader, user work and shard reader. `db`, `r2` and
 * `bucket` replace the deployment's own (a budget test passes counted ones).
 */
export function locals(dep: Deployment, o: { identity?: Identity; db?: CloudD1; r2?: CloudR2; bucket?: ShardBucket; cache?: ShardCache | null } = {}): RequestServices {
  const identity = o.identity ?? grantedIdentity(ids.clientA, [CASE_ID]).identity;
  const db = o.db ?? dep.db;
  if (!dep.db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'uw_binding'").get()) { dep.db.sqlite.exec(MIGRATION); bind(dep.db.sqlite); }
  const config = userWorkConfig({ clientId: ids.clientA, limits: LIMITS });
  const audit = { append: async (e: { eventId: string }) => ({ eventId: e.eventId }) } as RequestServices['audit'];
  const results = createCloudResults({ bindings: { db, bucket: o.r2 ?? dep.r2 }, clientId: ids.clientA, budgets: BUDGETS, identity, now, record: async () => {},
    stateRevision: d1WorkRevision({ db: db as never, config }) });
  const userWork = createD1UserWork({ db: db as never, config, identity, audit, store: results.store, now, tableDefinitions: null });
  const shards = createShardReader({ bucket: o.bucket ?? dep.bucket, clientId: ids.clientA, cache: o.cache === undefined ? memoryShardCache() : o.cache });
  return { identity, store: results.store, assets: results.assets, userWork, audit, runtime: { now }, shards } as unknown as RequestServices;
}
export const caseId = CASE_ID as CaseId;
