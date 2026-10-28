// `build`: imports the package into a throwaway local store with the local service, checks that the rows D1 will hold
// reproduce the version's read-model digest the way the hosted reader recomputes it, runs every shard module in ./shards/
// and writes `<out>/shards/` (with `manifest.json`) and `<out>/register.json`. Everything it writes holds case content:
// `<out>` belongs under `.local/`.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configFromEnv } from '../../src/lib/local-case/config.server.ts';
import { viewContentOf } from '../../src/lib/local-case/results.server.ts';
import { LocalCase, type ImportReport } from '../../src/lib/local-case/service.server.ts';
import { validShardName } from '../../src/lib/results/hosted/shards.ts';
import { readModelDigest } from '../../src/lib/results/hosted/read-model.ts';
import type { PayloadManifest } from '../../src/lib/views/payloads/manifest.ts';
import { MANIFEST_NAME, shardManifest } from './manifest.ts';
import type { BuildContext, BuildRecord, Shard, ShardModule } from './types.ts';

export interface BuildOptions {
  packageDir: string; caseFolder: string; caseId: string; out: string;
  now?: () => Date;
  builder?: { sha: string; bun: string };
}
export interface Built { manifest: PayloadManifest; manifestSha256: string; record: BuildRecord }

const SHARDS_DIR = fileURLToPath(new URL('./shards/', import.meta.url));
export const shardsOut = (out: string) => path.join(out, 'shards');
export const recordPath = (out: string) => path.join(out, 'register.json');

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

export async function build(o: BuildOptions): Promise<Built> {
  const now = o.now ?? (() => new Date());
  await rm(shardsOut(o.out), { recursive: true, force: true });
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
    const shards: Shard[] = [];
    for (const m of await shardModules()) shards.push(...(await m.build(ctx)));
    const seen = new Set<string>();
    for (const s of shards) {
      if (!validShardName(s.name) || s.name === MANIFEST_NAME) throw new Error(`invalid shard name ${JSON.stringify(s.name)}`);
      if (seen.has(s.name)) throw new Error(`two shards are named ${s.name}`);
      seen.add(s.name);
    }

    const builtAt = now().toISOString();
    const packageBytes = Number((lc.storage.db().prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS n FROM package_file WHERE version_id = ?').get(rv) as { n: number }).n);
    const m = shardManifest({
      caseId: o.caseId, resultsVersion: rv, manifestSha256: v.manifest_sha256, readModelSha256: v.read_model_sha256,
      validatorVersion: v.validator_version, diagnosticsSha256: v.diagnostics_sha256, warningFingerprints: [...report.warningFingerprints].sort(),
      counts: { ...expect, listPages: shards.filter((s) => /^list\/page-\d+\.json$/.test(s.name)).length },
      builtAt, builder: o.builder ?? builderIdentity(),
    }, shards);
    for (const s of [...shards, { name: MANIFEST_NAME, bytes: m.bytes }]) {
      const file = path.join(shardsOut(o.out), s.name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, s.bytes);
    }

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
  } finally {
    await lc.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}
