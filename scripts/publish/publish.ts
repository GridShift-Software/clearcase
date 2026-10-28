// `register` and `publish`: the version's rows into D1, then the publication flip, bound to the manifest R2 holds.
import { sha256Hex } from './manifest.ts';
import type { D1Exec } from './d1.ts';
import { publicationQuery, publishSql, registerSql, sq } from './sql.ts';
import type { BuildRecord } from './types.ts';

export async function register(d1: D1Exec, r: BuildRecord, a: { at: string; acknowledgedMissing: number }): Promise<void> {
  const missing = r.diagnostics.ASSET_MISSING_AT_BUILD ?? 0;
  if (missing > a.acknowledgedMissing)
    throw new Error(`the package was converted against a partial case folder: ${missing} ASSET_MISSING_AT_BUILD, ${a.acknowledgedMissing} acknowledged (--acknowledged-missing)`);
  await d1.file(registerSql(r, { operationId: `publish-cli:${r.shardManifestSha256.slice(0, 12)}`, at: a.at }));
  const rows = await d1.all<{ state: string; read_model_sha256: string; manifest: string | null }>(
    `SELECT v.state, v.read_model_sha256, m.manifest_sha256 AS manifest FROM rs_results_version v LEFT JOIN rs_shard_manifest m ON m.version_id = v.version_id WHERE v.version_id = ${sq(r.resultsVersion)} AND v.case_id = ${sq(r.caseId)}`);
  const v = rows[0];
  if (v?.state !== 'stored' || v.read_model_sha256 !== r.version.readModelSha256) throw new Error('the version is not stored with this read model after register');
  if (v.manifest !== r.shardManifestSha256) throw new Error('the version is published with another shard manifest: build again only for a new version');
}

export interface Published { state: string; version_id: string; previous_version_id: string | null; published_at: string | null; manifest_sha256: string | null }

/** Publishes the version if a sign-off binds the manifest R2 holds; refuses otherwise. */
export async function publish(d1: D1Exec, r: BuildRecord, a: { remoteManifest: Uint8Array | null; at: string }): Promise<Published> {
  if (!a.remoteManifest) throw new Error('R2 holds no manifest.json for this version: upload first');
  const remote = sha256Hex(a.remoteManifest);
  if (remote !== r.shardManifestSha256) throw new Error('the manifest in R2 is not the one this build wrote: upload again');
  await d1.file(publishSql({ caseId: r.caseId, resultsVersion: r.resultsVersion, remoteManifestSha256: remote, at: a.at }));
  const row = (await d1.all<Published>(publicationQuery(r.caseId)))[0];
  if (row?.state !== 'published' || row.version_id !== r.resultsVersion) throw new Error('publication refused: no sign-off binds the shard manifest stored in R2');
  return row;
}
