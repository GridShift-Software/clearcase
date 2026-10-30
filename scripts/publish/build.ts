// `build`: imports the package into a throwaway local store with the local service, checks that the rows D1 will hold
// reproduce the version's read-model digest the way the hosted reader recomputes it, runs every shard module in ./shards/
// and writes `<out>/shards/` (with `manifest.json`) and `<out>/register.json`. `build --family <name>` runs one module
// for a version already built into `<out>` and writes its shards and amendment beside the others, so `<out>/shards/`
// mirrors the version's R2 prefix. Everything it writes holds case content: `<out>` belongs under `.local/`.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configFromEnv } from '../../src/lib/local-case/config.server.ts';
import { viewContentOf } from '../../src/lib/local-case/results.server.ts';
import { LocalCase, type ImportReport } from '../../src/lib/local-case/service.server.ts';
import { validShardName } from '../../src/lib/results/hosted/shards.ts';
import { readModelDigest } from '../../src/lib/results/hosted/read-model.ts';
import type { PayloadManifest } from '../../src/lib/views/payloads/manifest.ts';
import { MANIFEST_NAME, readIndex, shardAmendment, shardManifest } from './manifest.ts';
import type { BuildContext, BuildRecord, Shard, ShardAmendment, ShardModule } from './types.ts';

export interface BuildOptions {
  packageDir: string; caseFolder: string; caseId: string; out: string;
  now?: () => Date;
  builder?: { sha: string; bun: string };
  /** The shard modules; tests pass their own. Default: every module in ./shards/. */
  modules?: readonly ShardModule[];
}
export interface Built { manifest: PayloadManifest; manifestSha256: string; record: BuildRecord }
export interface BuiltAmendment { amendment: ShardAmendment; bytes: Uint8Array; sha256: string; name: string }

const SHARDS_DIR = fileURLToPath(new URL('./shards/', import.meta.url));
export const shardsOut = (out: string) => path.join(out, 'shards');
export const recordPath = (out: string) => path.join(out, 'register.json');
const amendmentsOut = (out: string) => path.join(shardsOut(out), 'amendments');

/** The shard modules, by file name: a family is added by adding a file. */
export async function shardModules(dir = SHARDS_DIR): Promise<ShardModule[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  return Promise.all(files.map(async (f) => {
    const m = (await import(pathToFileURL(path.join(dir, f)).href)) as { default?: Partial<ShardModule> };
    if (typeof m.default?.name !== 'string' || typeof m.default.build !== 'function') throw new Error(`shards/${f} has no default ShardModule export`);
    return m.default as ShardModule;
  }));
}

function builderIdentity(): { sha: string; bun: string } {
  let sha = 'unknown';
  try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(SHARDS_DIR), encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  return { sha, bun: process.versions.bun ?? 'none' };
}

interface Imported {
  lc: LocalCase; rv: string; report: ImportReport; v: NonNullable<ReturnType<LocalCase['store']['getVersion']>>;
  expect: BuildRecord['version']['expect']; docRows: BuildRecord['rows']['documents']; ctx: BuildContext;
}

/** Imports the package into a throwaway local store under `out`, checks the rows D1 will hold, and runs `use` on it. */
async function imported<T>(o: BuildOptions, use: (i: Imported) => Promise<T>): Promise<T> {
  await mkdir(o.out, { recursive: true });
  const dataDir = await mkdtemp(path.join(o.out, '.store-'));
  const lc = new LocalCase(configFromEnv({ CLEARCASE_DATA_DIR: dataDir, PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' }));
  try {
    const lock = lc.storage.acquireInstanceLock();
    if (!lock.ok) throw new Error(lock.reason);
    await lc.startup();
    const outcome = await lc.importPackage(path.resolve(o.caseFolder), path.resolve(o.packageDir));
    const report = JSON.parse(lc.store.getImport(outcome.importId)!.report) as ImportReport;
    if (outcome.kind === 'rejected') throw new Error(`the package was rejected: ${[...report.app, ...report.diagnostics].filter((d) => d.severity === 'error').map((d) => d.code).join(', ')}`);
    if (report.caseId !== o.caseId) throw new Error(`the package is for another case than --case-id ${o.caseId}`);
    const rv = report.resultsVersion!;
    const check = lc.verify(rv, true);
    if (!check.ok) throw new Error(`the imported version failed its integrity check: ${check.reason}`);
    const v = lc.store.getVersion(rv)!;
    const { documents, assets, seeds } = lc.store.projectionRows(rv);
    const expect = JSON.parse(v.expect) as BuildRecord['version']['expect'];

    // D1's rows, and the digest the hosted reader computes from them (loadVerifiedModel): it must be the version's own.
    const listByRef = new Map((JSON.parse(lc.store.chronologyJson(rv)!) as { ref: string }[]).map((l) => [l.ref, l]));
    const docRows = [...documents].sort((a, b) => a.ord - b.ord).map((d) => ({ ...d, list_json: JSON.stringify(listByRef.get(d.ref)) }));
    const hosted = await readModelDigest({
      documents: docRows, assets, seeds, overview: v.overview, expect,
      chronologyJson: JSON.stringify(docRows.map((d) => JSON.parse(d.list_json))),
    });
    if (hosted !== v.read_model_sha256) throw new Error('the rows for D1 do not reproduce the version read-model digest');

    const vc = viewContentOf(lc.store, rv);
    const json = (name: string, value: unknown): Shard => ({ name, bytes: new TextEncoder().encode(JSON.stringify(value)) });
    const ctx: BuildContext = { caseId: o.caseId, resultsVersion: rv, store: lc.store, vc, pure: { store: lc.store, vid: rv, vc }, json };
    return await use({ lc, rv, report, v, expect, docRows, ctx });
  } finally {
    await lc.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Runs `modules` and checks every name: valid, unique, and neither a manifest nor an amendment. */
async function runModules(modules: readonly ShardModule[], ctx: BuildContext): Promise<Shard[]> {
  const shards: Shard[] = [];
  for (const m of modules) shards.push(...(await m.build(ctx)));
  const seen = new Set<string>();
  for (const s of shards) {
    if (!validShardName(s.name) || s.name === MANIFEST_NAME || s.name.startsWith('amendments/')) throw new Error(`invalid shard name ${JSON.stringify(s.name)}`);
    if (seen.has(s.name)) throw new Error(`two shards are named ${s.name}`);
    seen.add(s.name);
  }
  return shards;
}

async function writeShards(out: string, shards: readonly Shard[]) {
  for (const s of shards) {
    const file = path.join(shardsOut(out), s.name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, s.bytes);
  }
}

/** The version's whole shard set and its manifest.json, for a version not yet published. */
export async function build(o: BuildOptions): Promise<Built> {
  const now = o.now ?? (() => new Date());
  if ((await readdir(amendmentsOut(o.out)).catch(() => [])).length)
    throw new Error(`${o.out} holds amendments of a published version: build a new version into a new --out, or add a family with build --family`);
  await rm(shardsOut(o.out), { recursive: true, force: true });
  return imported(o, async ({ lc, rv, report, v, expect, docRows, ctx }) => {
    const shards = await runModules(o.modules ?? await shardModules(), ctx);
    const { assets, seeds } = lc.store.projectionRows(rv);
    const builtAt = now().toISOString();
    const packageBytes = Number((lc.storage.db().prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS n FROM package_file WHERE version_id = ?').get(rv) as { n: number }).n);
    const m = shardManifest({
      caseId: o.caseId, resultsVersion: rv, manifestSha256: v.manifest_sha256, readModelSha256: v.read_model_sha256,
      validatorVersion: v.validator_version, diagnosticsSha256: v.diagnostics_sha256, warningFingerprints: [...report.warningFingerprints].sort(),
      counts: { ...expect, listPages: shards.filter((s) => /^list\/page-\d+\.json$/.test(s.name)).length },
      builtAt, builder: o.builder ?? builderIdentity(),
    }, shards);
    await writeShards(o.out, [...shards, { name: MANIFEST_NAME, bytes: m.bytes }]);

    const record: BuildRecord = {
      format: 'clearcase.publish-build/1', caseId: o.caseId, resultsVersion: rv, shardManifestSha256: m.sha256, builtAt,
      version: {
        caseLabel: v.case_label, inputRevisionId: v.input_revision_id, created: v.created, verdict: v.verdict as 'accept' | 'report',
        manifestSha256: v.manifest_sha256, validatorVersion: v.validator_version, diagnosticsSha256: v.diagnostics_sha256,
        warningFingerprints: m.manifest.warningFingerprints, expect, readModelSha256: v.read_model_sha256, overview: v.overview, packageBytes,
      },
      diagnostics: report.counts,
      rows: {
        documents: docRows,
        assets: assets.map((a) => ({ key: a.key, row_json: JSON.stringify(a) })),
        seeds: seeds.map((s) => ({ ...s })),
      },
    };
    await writeFile(recordPath(o.out), JSON.stringify(record));
    await chmod(recordPath(o.out), 0o600);
    return { manifest: m.manifest, manifestSha256: m.sha256, record };
  });
}

/**
 * One family added to the version `<out>` was built and published for: the family's module alone, over the same package,
 * written beside the version's shards with its amendment (`amendments/<sha256>.json`), bound to `<out>/shards/manifest.json`.
 * Refuses a family none of the modules is named, a different version, and any name the signed manifest already lists.
 */
export async function buildFamily(o: BuildOptions & { family: string }): Promise<BuiltAmendment> {
  const record = JSON.parse(await readFile(recordPath(o.out), 'utf8').catch(() => { throw new Error(`${o.out} holds no register.json: build --family adds to a version built into this --out`); })) as BuildRecord;
  const parentBytes = new Uint8Array(await readFile(path.join(shardsOut(o.out), MANIFEST_NAME)));
  const parent = readIndex(MANIFEST_NAME, parentBytes);
  if (parent.sha256 !== record.shardManifestSha256) throw new Error(`${o.out}/shards/manifest.json is not the manifest register.json was built with`);
  const modules = (o.modules ?? await shardModules()).filter((m) => m.name === o.family);
  if (!modules.length) throw new Error(`no shard module is named ${o.family} (the name field of a module in scripts/publish/shards/)`);
  return imported(o, async ({ rv, ctx }) => {
    if (rv !== record.resultsVersion) throw new Error(`the package is version ${rv}, not ${record.resultsVersion} that ${o.out} was built for`);
    const shards = await runModules(modules, ctx);
    if (!shards.length) throw new Error(`the ${o.family} module built no shards`);
    const listed = new Set(parent.shards.map((s) => s.name));
    const taken = shards.filter((s) => listed.has(s.name)).map((s) => s.name);
    if (taken.length) throw new Error(`${taken.join(', ')} already in the version's manifest: an amendment only adds shards, and a published shard is never replaced`);
    const a = shardAmendment({ caseId: o.caseId, resultsVersion: rv, parentManifestSha256: parent.sha256, family: o.family }, shards);
    // An earlier local build of this family that was never uploaded is replaced; R2 keeps what it holds.
    for (const earlier of await localAmendments(o.out)) if (earlier.amendment.family === o.family) await rm(path.join(shardsOut(o.out), earlier.name));
    await writeShards(o.out, [...shards, { name: a.name, bytes: a.bytes }]);
    return a;
  });
}

/** The amendments built into `<out>`. */
export async function localAmendments(out: string): Promise<BuiltAmendment[]> {
  const files = (await readdir(amendmentsOut(out)).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => {
    const name = `amendments/${f}`, bytes = new Uint8Array(await readFile(path.join(shardsOut(out), name)));
    const ix = readIndex(name, bytes);
    return { amendment: ix.amendment!, bytes, sha256: ix.sha256, name };
  }));
}

/** The amendment `build --family <family>` wrote into `<out>`. */
export async function localAmendment(out: string, family: string): Promise<BuiltAmendment> {
  const found = (await localAmendments(out)).filter((a) => a.amendment.family === family);
  if (found.length !== 1) throw new Error(`${out} holds ${found.length} amendments for family ${family}: run build --family ${family} first`);
  return found[0]!;
}
