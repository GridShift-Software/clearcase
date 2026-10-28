// `register`, `amend` and `publish`: the version's rows into D1, verified as D1 holds them; an amendment's entries; then
// the publication flip or an amendment's admission, bound to what R2 holds.
import { loadVerifiedModel } from '../../src/lib/results/hosted/model.ts';
import type { ShardEntry } from '../../src/lib/views/payloads/manifest.ts';
import { d1Reader, type D1Exec } from './d1.ts';
import { MANIFEST_NAME, readIndex, sha256Hex, type ShardIndex } from './manifest.ts';
import { admissionQuery, admittedQuery, admitAmendmentSql, amendmentSql, entriesQuery, entriesSql, publicationQuery, publishSql, rowsSql, shardManifestSql, sq, storeSql, type Rows } from './sql.ts';
import type { BuildRecord } from './types.ts';

type VersionRow = { state: string; case_id: string; read_model_sha256: string };
const versionRow = async (d1: D1Exec, rv: string) =>
  (await d1.all<VersionRow>(`SELECT state, case_id, read_model_sha256 FROM rs_results_version WHERE version_id = ${sq(rv)}`))[0] ?? null;

/**
 * The read-model rows D1 lacks for a version still staging. A row D1 already holds must be the build's exactly: one with
 * other content is refused, not ignored.
 */
async function missingRows(d1: D1Exec, r: BuildRecord): Promise<Rows> {
  const rv = sq(r.resultsVersion);
  const [docs, assets, seeds] = await Promise.all([
    d1.all<Rows['documents'][number]>(`SELECT ref, ord, row_json, state_json, list_json, attachments_json FROM rs_document WHERE version_id = ${rv}`),
    d1.all<{ key: string; row_json: string }>(`SELECT asset_key AS key, row_json FROM rs_asset WHERE version_id = ${rv}`),
    d1.all<Rows['seeds'][number]>(`SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM rs_seed WHERE version_id = ${rv}`),
  ]);
  const lacking = <T>(table: string, held: readonly T[], built: readonly T[], key: (x: T) => string | number, fields: readonly (keyof T)[]) => {
    const byKey = new Map(held.map((x) => [key(x), x]));
    return built.filter((x) => {
      const there = byKey.get(key(x));
      if (!there) return true;
      if (fields.some((f) => String(there[f]) !== String(x[f]))) throw new Error(`register refused: D1 already holds ${table} ${key(x)} for ${r.resultsVersion} with other content than this build; nothing was changed`);
      return false;
    });
  };
  return {
    documents: lacking('rs_document', docs, r.rows.documents, (d) => d.ref, ['ord', 'row_json', 'state_json', 'list_json', 'attachments_json']),
    assets: lacking('rs_asset', assets, r.rows.assets, (a) => a.key, ['row_json']),
    seeds: lacking('rs_seed', seeds, r.rows.seeds, (s) => s.ord, ['dataset_key', 'seed_id', 'seed_sha256', 'record_json']),
  };
}

/** The entries of `ix` D1 lacks under its sha256; an entry there with other bytes refuses. */
async function missingEntries(d1: D1Exec, rv: string, ix: ShardIndex): Promise<ShardEntry[]> {
  const held = new Map((await d1.all<ShardEntry>(entriesQuery(rv, ix.sha256))).map((e) => [e.name, e]));
  return ix.shards.filter((e) => {
    const there = held.get(e.name);
    if (there && (there.sha256 !== e.sha256 || Number(there.bytes) !== e.bytes)) throw new Error(`D1 already lists ${e.name} under ${ix.name} ${ix.sha256} with other bytes`);
    return !there;
  });
}

async function expectEntries(d1: D1Exec, rv: string, ix: ShardIndex) {
  const held = (await d1.all<ShardEntry>(entriesQuery(rv, ix.sha256))).map((e) => ({ name: e.name, bytes: Number(e.bytes), sha256: e.sha256 }));
  if (JSON.stringify(held) !== JSON.stringify(ix.shards.map((e) => ({ name: e.name, bytes: e.bytes, sha256: e.sha256 })))) throw new Error(`D1 does not list exactly the shards of ${ix.name} ${ix.sha256}`);
}

/**
 * Writes the version's rows and its shard manifest, then verifies what D1 holds: the rows are read back and their digest
 * recomputed by loadVerifiedModel, as the hosted reader does, before the version is stored. A row D1 already holds must be
 * the build's; a stored version's rows are never written again, only compared and verified. `manifest` is `<out>/shards/manifest.json`.
 */
export async function register(d1: D1Exec, r: BuildRecord, a: { at: string; acknowledgedMissing: number; manifest: Uint8Array }): Promise<void> {
  const missing = r.diagnostics.ASSET_MISSING_AT_BUILD ?? 0;
  if (missing > a.acknowledgedMissing)
    throw new Error(`the package was converted against a partial case folder: ${missing} ASSET_MISSING_AT_BUILD, ${a.acknowledgedMissing} acknowledged (--acknowledged-missing)`);
  const foreign = () => new Error('the manifest.json beside register.json is not the one this build wrote');
  if (sha256Hex(a.manifest) !== r.shardManifestSha256) throw foreign();
  const ix = readIndex(MANIFEST_NAME, a.manifest);
  if (ix.caseId !== r.caseId || ix.resultsVersion !== r.resultsVersion) throw foreign();
  const rv = r.resultsVersion;
  const before = await versionRow(d1, rv);
  if (before && (before.case_id !== r.caseId || before.read_model_sha256 !== r.version.readModelSha256))
    throw new Error(`register refused: D1 holds ${rv} for another case or read model; nothing was changed`);
  const verify = async () => {
    try { await loadVerifiedModel(d1Reader(d1), rv); }
    catch { throw new Error(`register refused: the rows D1 holds for ${rv} do not reproduce its read-model digest; nothing was changed, and the version cannot be signed off`); }
  };
  if (before?.state === 'stored') {
    await verify();
    const rows = await missingRows(d1, r);
    if (rows.documents.length + rows.assets.length + rows.seeds.length) throw new Error(`register refused: stored version ${rv} lacks rows of this build; a stored model is never changed`);
  } else {
    await d1.file(rowsSql(r, { operationId: `publish-cli:${r.shardManifestSha256.slice(0, 12)}`, at: a.at, rows: before ? await missingRows(d1, r) : r.rows }));
    await verify();
  }
  if (before?.state !== 'stored') await d1.file(storeSql(r, { at: a.at }));
  const after = await versionRow(d1, rv);
  if (after?.state !== 'stored') throw new Error('the version is not stored with this read model after register');
  await d1.file(shardManifestSql(r));
  const m = await d1.all<{ manifest: string }>(`SELECT manifest_sha256 AS manifest FROM rs_shard_manifest WHERE version_id = ${sq(rv)}`);
  if (m[0]?.manifest !== r.shardManifestSha256) throw new Error('the version is published with another shard manifest: build again only for a new version, or add a family with build --family');
  const lacking = await missingEntries(d1, rv, ix);
  if (lacking.length) await d1.file(entriesSql(rv, ix.sha256, lacking).join('\n') + '\n');
  await expectEntries(d1, rv, ix);
}

const admitted = async (d1: D1Exec, rv: string): Promise<Record<string, number>> =>
  JSON.parse((await d1.all<{ admitted_json: string | null }>(admittedQuery(rv)))[0]?.admitted_json ?? '{}') as Record<string, number>;

/**
 * Registers an amendment (`amendments/<sha256>.json`) of the version `r` describes: its row and its entries. Refuses an
 * amendment of another version or manifest, of a version whose manifest is not published, and one naming a shard the
 * version already serves.
 */
export async function amend(d1: D1Exec, r: BuildRecord, bytes: Uint8Array, a: { at: string }): Promise<{ sha256: string; family: string; shards: number }> {
  const ix = readIndex(`amendments/${sha256Hex(bytes)}.json`, bytes), x = ix.amendment!, rv = r.resultsVersion;
  if (x.caseId !== r.caseId || x.resultsVersion !== rv || x.parentManifestSha256 !== r.shardManifestSha256) throw new Error(`the amendment is not of ${rv}'s manifest ${r.shardManifestSha256}`);
  const served = await admitted(d1, rv);
  const taken = ix.shards.filter((s) => Object.hasOwn(served, s.name)).map((s) => s.name);
  if (taken.length) throw new Error(`amend refused: ${taken.join(', ')} already admitted for ${rv}; a published shard is never replaced`);
  await d1.file(amendmentSql({ amendment: x, sha256: ix.sha256, at: a.at }));
  const row = await d1.all<{ n: number }>(`SELECT COUNT(*) AS n FROM rs_shard_amendment WHERE version_id = ${sq(rv)} AND amendment_sha256 = ${sq(ix.sha256)}`);
  if (Number(row[0]?.n) !== 1) throw new Error(`amend refused: ${rv} is not published with manifest ${r.shardManifestSha256} (or it is withdrawn); publish the version first`);
  const lacking = await missingEntries(d1, rv, ix);
  if (lacking.length) await d1.file(entriesSql(rv, ix.sha256, lacking).join('\n') + '\n');
  await expectEntries(d1, rv, ix);
  return { sha256: ix.sha256, family: x.family, shards: ix.shards.length };
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

/** Admits an amendment into the version's served set if a sign-off binds it and R2 holds exactly it; refuses otherwise. */
export async function publishAmendment(d1: D1Exec, r: BuildRecord, a: { amendment: Uint8Array; remote: Uint8Array | null; at: string }): Promise<{ admittedAt: string; served: number }> {
  const sha = sha256Hex(a.amendment), rv = r.resultsVersion;
  if (!a.remote) throw new Error(`R2 holds no amendments/${sha}.json for this version: upload --family first`);
  if (sha256Hex(a.remote) !== sha) throw new Error('the amendment in R2 is not the one this build wrote: upload --family again');
  const signed = await d1.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pub_shard_signoff WHERE version_id = ${sq(rv)} AND shard_manifest_sha256 = ${sq(sha)}`);
  if (!Number(signed[0]?.n)) throw new Error(`publication refused: no sign-off binds amendment ${sha} (signoff --family)`);
  await d1.file(admitAmendmentSql({ caseId: r.caseId, resultsVersion: rv, amendmentSha256: sha, at: a.at }));
  const row = (await d1.all<{ admitted_at: string }>(admissionQuery(rv, sha)))[0];
  if (!row) {
    const ix = readIndex(`amendments/${sha}.json`, a.amendment), served = await admitted(d1, rv);
    const taken = ix.shards.filter((s) => Object.hasOwn(served, s.name)).map((s) => s.name);
    throw new Error(taken.length ? `publication refused: ${taken.join(', ')} already admitted for ${rv}` : `publication refused: amendment ${sha} is not registered (amend) for ${rv}'s admitted manifest, or the version is withdrawn`);
  }
  return { admittedAt: row.admitted_at, served: Object.keys(await admitted(d1, rv)).length };
}
