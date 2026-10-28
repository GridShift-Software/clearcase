// The D1 rows `register`, `amend`, `signoff` and `publish` write, as SQL text for `wrangler d1 execute --file`. Nothing
// here ignores a conflicting row: the callers read what D1 holds first and pass only the rows it lacks, so a row that
// is already there with other content fails the statement. A version is stored only once its rows verify, a publication
// changes only when a sign-off binds the shard manifest R2 holds, and a shard is served only once admitted.
import { shardPrefix } from '../../src/lib/results/hosted/shards.ts';
import type { ShardEntry } from '../../src/lib/views/payloads/manifest.ts';
import type { BuildRecord, ShardAmendment } from './types.ts';

/** D1 refuses a statement over 100 KB; multi-row inserts stay under this. */
export const STATEMENT_BYTES = 90_000;
const ROWS_PER_INSERT = 100;

export const sq = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);
const size = (s: string) => Buffer.byteLength(s, 'utf8');

/** `INSERT` of rows in as few statements as fit under STATEMENT_BYTES. A row already present fails its statement. */
export function inserts(table: string, cols: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string[] {
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n`;
  const out: string[] = [];
  let batch: string[] = [], bytes = size(head);
  const flush = () => { if (batch.length) out.push(`${head}${batch.join(',\n')};`); batch = []; bytes = size(head); };
  for (const r of rows) {
    const tuple = `(${r.map(sq).join(', ')})`;
    const n = size(tuple) + 2;
    if (size(head) + n > STATEMENT_BYTES) throw new Error(`one ${table} row is over ${STATEMENT_BYTES} bytes of SQL`);
    if (batch.length >= ROWS_PER_INSERT || bytes + n > STATEMENT_BYTES) flush();
    batch.push(tuple);
    bytes += n;
  }
  flush();
  return out;
}

export type Rows = BuildRecord['rows'];

/**
 * The version (`staging`, when D1 has none) and the read-model rows D1 lacks: `rs_case` (kept if present),
 * `rs_results_version`, `rs_document`, `rs_asset`, `rs_seed`. No package files, candidate or evidence rows.
 */
export function rowsSql(r: BuildRecord, a: { operationId: string; at: string; rows: Rows }): string {
  const rv = r.resultsVersion, v = r.version;
  const versionCols = ['version_id', 'case_id', 'state', 'attempt', 'operation_id', 'manifest_sha256', 'input_revision_id', 'case_label', 'created', 'verdict', 'validator_version',
    'diagnostics_sha256', 'warning_fingerprints', 'expected_documents', 'expected_assets', 'expected_seeds', 'expected_files', 'read_model_sha256', 'overview', 'package_bytes', 'keep', 'staged_at', 'import_seq'];
  const versionValues = [rv, r.caseId, 'staging', 1, a.operationId, v.manifestSha256, v.inputRevisionId, v.caseLabel, v.created, v.verdict, v.validatorVersion,
    v.diagnosticsSha256, JSON.stringify(v.warningFingerprints), v.expect.documents, v.expect.assets, v.expect.seeds, v.expect.files, v.readModelSha256, v.overview, v.packageBytes, 0, a.at];
  return [
    `INSERT OR IGNORE INTO rs_case (case_id, case_label) VALUES (${sq(r.caseId)}, ${sq(v.caseLabel)});`,
    `INSERT INTO rs_results_version (${versionCols.join(', ')})
  SELECT ${versionValues.map(sq).join(', ')}, COALESCE((SELECT MAX(import_seq) FROM rs_results_version), 0) + 1
  WHERE NOT EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ${sq(rv)});`,
    ...inserts('rs_document', ['version_id', 'ref', 'ord', 'row_json', 'state_json', 'list_json', 'attachments_json'],
      a.rows.documents.map((d) => [rv, d.ref, d.ord, d.row_json, d.state_json, d.list_json, d.attachments_json])),
    ...inserts('rs_asset', ['version_id', 'asset_key', 'row_json'], a.rows.assets.map((x) => [rv, x.key, x.row_json])),
    ...inserts('rs_seed', ['version_id', 'ord', 'dataset_key', 'seed_id', 'seed_sha256', 'record_json'], a.rows.seeds.map((s) => [rv, s.ord, s.dataset_key, s.seed_id, s.seed_sha256, s.record_json])),
  ].join('\n') + '\n';
}

/** Stores a staging version whose rows `register` has verified, when every count matches. */
export function storeSql(r: BuildRecord, a: { at: string }): string {
  const rv = sq(r.resultsVersion);
  return `UPDATE rs_results_version SET state = 'stored', stored_at = ${sq(a.at)}
  WHERE version_id = ${rv} AND state = 'staging' AND case_id = ${sq(r.caseId)} AND read_model_sha256 = ${sq(r.version.readModelSha256)}
    AND expected_documents = (SELECT COUNT(*) FROM rs_document WHERE version_id = ${rv})
    AND expected_assets = (SELECT COUNT(*) FROM rs_asset WHERE version_id = ${rv})
    AND expected_seeds = (SELECT COUNT(*) FROM rs_seed WHERE version_id = ${rv});\n`;
}

/**
 * The shard manifest a stored version is served from (`rs_shard_manifest`). The row follows a rebuild only until the
 * version's manifest is admitted (published): then it is the one its sign-off bound, and the table's trigger refuses any
 * other.
 */
export function shardManifestSql(r: BuildRecord): string {
  const rv = sq(r.resultsVersion);
  return `INSERT INTO rs_shard_manifest (version_id, prefix, manifest_sha256, built_at)
  SELECT ${rv}, ${sq(shardPrefix(r.resultsVersion))}, ${sq(r.shardManifestSha256)}, ${sq(r.builtAt)}
  WHERE EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ${rv} AND state = 'stored')
  ON CONFLICT (version_id) DO UPDATE SET manifest_sha256 = excluded.manifest_sha256, built_at = excluded.built_at
  WHERE NOT EXISTS (SELECT 1 FROM rs_shard_admission WHERE version_id = excluded.version_id)
    AND NOT EXISTS (SELECT 1 FROM rs_publication WHERE version_id = excluded.version_id AND state = 'published');\n`;
}

/** The entries of one manifest or amendment that D1 lacks. */
export const entriesSql = (rv: string, listSha256: string, entries: readonly ShardEntry[]) =>
  inserts('rs_shard_entry', ['version_id', 'manifest_sha256', 'name', 'sha256', 'bytes'], entries.map((e) => [rv, listSha256, e.name, e.sha256, e.bytes]));

/** The entries of one manifest or amendment that D1 holds. */
export const entriesQuery = (rv: string, listSha256: string) =>
  `SELECT name, sha256, bytes FROM rs_shard_entry WHERE version_id = ${sq(rv)} AND manifest_sha256 = ${sq(listSha256)} ORDER BY name`;

/** An amendment of a version whose signed manifest is admitted and that is not withdrawn; its entries follow once it is there. */
export function amendmentSql(a: { amendment: ShardAmendment; sha256: string; at: string }): string {
  const x = a.amendment, rv = sq(x.resultsVersion), parent = sq(x.parentManifestSha256);
  return `INSERT INTO rs_shard_amendment (version_id, amendment_sha256, case_id, parent_sha256, family, shards, registered_at)
  SELECT ${rv}, ${sq(a.sha256)}, ${sq(x.caseId)}, ${parent}, ${sq(x.family)}, ${x.shards.length}, ${sq(a.at)}
  WHERE EXISTS (SELECT 1 FROM rs_shard_manifest m JOIN rs_results_version v ON v.version_id = m.version_id AND v.case_id = ${sq(x.caseId)} AND v.state = 'stored'
      JOIN rs_shard_admission s ON s.version_id = m.version_id AND s.manifest_sha256 = m.manifest_sha256
      WHERE m.version_id = ${rv} AND m.manifest_sha256 = ${parent})
    AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = ${rv})
    AND NOT EXISTS (SELECT 1 FROM rs_shard_amendment WHERE version_id = ${rv} AND amendment_sha256 = ${sq(a.sha256)});\n`;
}

export interface Acknowledgement { code: string; count: number; reason: string }

/**
 * One attestation, written only for a manifest or amendment registered for this stored version. The caller has checked
 * that no identical attestation exists; an identical one racing in fails the table's unique key.
 */
export function signoffSql(r: BuildRecord, a: { target: string; signer: string; at: string; acknowledgements: readonly Acknowledgement[] }): string {
  const rv = sq(r.resultsVersion), v = r.version, target = sq(a.target);
  const values = [r.resultsVersion, a.target, v.manifestSha256, v.validatorVersion, v.diagnosticsSha256, JSON.stringify(a.acknowledgements), a.signer, a.at];
  return `INSERT INTO pub_shard_signoff (version_id, shard_manifest_sha256, manifest_sha256, validator_version, diagnostics_sha256, acknowledgements_json, signer, signed_at)
  SELECT ${values.map(sq).join(', ')}
  WHERE EXISTS (SELECT 1 FROM rs_results_version v WHERE v.version_id = ${rv} AND v.state = 'stored' AND v.case_id = ${sq(r.caseId)})
    AND (EXISTS (SELECT 1 FROM rs_shard_manifest WHERE version_id = ${rv} AND manifest_sha256 = ${target})
      OR EXISTS (SELECT 1 FROM rs_shard_amendment WHERE version_id = ${rv} AND amendment_sha256 = ${target}));\n`;
}

/** The attestations of one manifest or amendment, oldest first. */
export const signoffsQuery = (rv: string, target: string) =>
  `SELECT signoff_id, signer, acknowledgements_json FROM pub_shard_signoff WHERE version_id = ${sq(rv)} AND shard_manifest_sha256 = ${sq(target)} ORDER BY signoff_id`;

/**
 * The publication flip. First the version's manifest is admitted, if a sign-off binds `remoteManifestSha256` (the hash of
 * the manifest R2 holds), that is the version's registered shard manifest and D1 holds its entries; the admission writes
 * the served name set. Then the case's row points at the version if that manifest is admitted. The version it replaces
 * becomes `previous_version_id`; publishing the current version again changes nothing.
 */
export function publishSql(a: { caseId: string; resultsVersion: string; remoteManifestSha256: string; at: string }): string {
  const c = sq(a.caseId), rv = sq(a.resultsVersion), sha = sq(a.remoteManifestSha256);
  return `INSERT INTO rs_shard_admission (version_id, manifest_sha256, admitted_at)
  SELECT ${rv}, ${sha}, ${sq(a.at)}
  WHERE EXISTS (SELECT 1 FROM pub_shard_signoff s
      JOIN rs_shard_manifest m ON m.version_id = s.version_id AND m.manifest_sha256 = s.shard_manifest_sha256
      JOIN rs_results_version v ON v.version_id = s.version_id AND v.state = 'stored' AND v.case_id = ${c}
      WHERE s.version_id = ${rv} AND s.shard_manifest_sha256 = ${sha})
    AND EXISTS (SELECT 1 FROM rs_shard_entry WHERE version_id = ${rv} AND manifest_sha256 = ${sha})
    AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = ${rv})
    AND NOT EXISTS (SELECT 1 FROM rs_shard_admission WHERE version_id = ${rv} AND manifest_sha256 = ${sha});
INSERT INTO rs_publication (case_id, state, version_id, previous_version_id, published_at)
  SELECT ${c}, 'published', ${rv}, NULL, ${sq(a.at)}
  WHERE EXISTS (SELECT 1 FROM rs_shard_admission s JOIN rs_shard_manifest m ON m.version_id = s.version_id AND m.manifest_sha256 = s.manifest_sha256
      JOIN rs_results_version v ON v.version_id = s.version_id AND v.state = 'stored' AND v.case_id = ${c}
      WHERE s.version_id = ${rv} AND s.manifest_sha256 = ${sha})
    AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = ${rv})
  ON CONFLICT (case_id) DO UPDATE SET
    previous_version_id = CASE WHEN rs_publication.version_id = excluded.version_id THEN rs_publication.previous_version_id ELSE rs_publication.version_id END,
    published_at = CASE WHEN rs_publication.version_id = excluded.version_id AND rs_publication.state = 'published' THEN rs_publication.published_at ELSE excluded.published_at END,
    state = 'published', version_id = excluded.version_id;\n`;
}

/**
 * Admits a registered amendment, in one statement: a sign-off binds it, its parent is the version's admitted manifest, the
 * version is not withdrawn, and none of its names is already admitted. The admission's trigger adds its names to the set.
 */
export function admitAmendmentSql(a: { caseId: string; resultsVersion: string; amendmentSha256: string; at: string }): string {
  const rv = sq(a.resultsVersion), sha = sq(a.amendmentSha256);
  return `INSERT INTO rs_shard_admission (version_id, manifest_sha256, admitted_at)
  SELECT ${rv}, ${sha}, ${sq(a.at)}
  WHERE EXISTS (SELECT 1 FROM pub_shard_signoff WHERE version_id = ${rv} AND shard_manifest_sha256 = ${sha})
    AND EXISTS (SELECT 1 FROM rs_shard_amendment x
      JOIN rs_shard_admission p ON p.version_id = x.version_id AND p.manifest_sha256 = x.parent_sha256
      JOIN rs_shard_manifest m ON m.version_id = x.version_id AND m.manifest_sha256 = x.parent_sha256
      WHERE x.version_id = ${rv} AND x.amendment_sha256 = ${sha} AND x.case_id = ${sq(a.caseId)}
        AND x.shards = (SELECT COUNT(*) FROM rs_shard_entry WHERE version_id = ${rv} AND manifest_sha256 = ${sha}))
    AND NOT EXISTS (SELECT 1 FROM rs_shard_entry n
      JOIN rs_shard_entry o ON o.version_id = n.version_id AND o.name = n.name
      JOIN rs_shard_admission s ON s.version_id = o.version_id AND s.manifest_sha256 = o.manifest_sha256
      WHERE n.version_id = ${rv} AND n.manifest_sha256 = ${sha})
    AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = ${rv})
    AND NOT EXISTS (SELECT 1 FROM rs_shard_admission WHERE version_id = ${rv} AND manifest_sha256 = ${sha});\n`;
}

/** The names the version serves, with their bytes, or null before its manifest is admitted. */
export const admittedQuery = (rv: string) => `SELECT admitted_json FROM rs_shard_manifest WHERE version_id = ${sq(rv)}`;
export const admissionQuery = (rv: string, sha: string) => `SELECT admitted_at FROM rs_shard_admission WHERE version_id = ${sq(rv)} AND manifest_sha256 = ${sq(sha)}`;

/** What `publish` reads back to confirm the flip. */
export const publicationQuery = (caseId: string) =>
  `SELECT p.state, p.version_id, p.previous_version_id, p.published_at, m.manifest_sha256 FROM rs_publication p LEFT JOIN rs_shard_manifest m ON m.version_id = p.version_id WHERE p.case_id = ${sq(caseId)}`;
