// The D1 rows `register`, `signoff` and `publish` write, as SQL text for `wrangler d1 execute --file`. Every file can run
// again: rows are inserted once, the version is stored only when every count matches, and a publication changes only
// when a sign-off binds the shard manifest R2 holds.
import { shardPrefix } from '../../src/lib/results/hosted/shards.ts';
import type { BuildRecord } from './types.ts';

/** D1 refuses a statement over 100 KB; multi-row inserts stay under this. */
export const STATEMENT_BYTES = 90_000;
const ROWS_PER_INSERT = 100;

export const sq = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);
const size = (s: string) => Buffer.byteLength(s, 'utf8');

/** `INSERT OR IGNORE` of rows in as few statements as fit under STATEMENT_BYTES. */
export function inserts(table: string, cols: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string[] {
  const head = `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES\n`;
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

/**
 * The version and its read model: `rs_case` (kept if present), `rs_results_version` (staging, then stored once the counts
 * match), `rs_document`, `rs_asset`, `rs_seed` and `rs_shard_manifest`. No package files, candidate or evidence rows.
 * The shard manifest row follows a rebuild only while the version is not published: a published one keeps what its
 * sign-off bound.
 */
export function registerSql(r: BuildRecord, a: { operationId: string; at: string }): string {
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
      r.rows.documents.map((d) => [rv, d.ref, d.ord, d.row_json, d.state_json, d.list_json, d.attachments_json])),
    ...inserts('rs_asset', ['version_id', 'asset_key', 'row_json'], r.rows.assets.map((x) => [rv, x.key, x.row_json])),
    ...inserts('rs_seed', ['version_id', 'ord', 'dataset_key', 'seed_id', 'seed_sha256', 'record_json'], r.rows.seeds.map((s) => [rv, s.ord, s.dataset_key, s.seed_id, s.seed_sha256, s.record_json])),
    `UPDATE rs_results_version SET state = 'stored', stored_at = ${sq(a.at)}
  WHERE version_id = ${sq(rv)} AND state = 'staging' AND case_id = ${sq(r.caseId)} AND read_model_sha256 = ${sq(v.readModelSha256)}
    AND expected_documents = (SELECT COUNT(*) FROM rs_document WHERE version_id = ${sq(rv)})
    AND expected_assets = (SELECT COUNT(*) FROM rs_asset WHERE version_id = ${sq(rv)})
    AND expected_seeds = (SELECT COUNT(*) FROM rs_seed WHERE version_id = ${sq(rv)});`,
    `INSERT INTO rs_shard_manifest (version_id, prefix, manifest_sha256, built_at)
  SELECT ${sq(rv)}, ${sq(shardPrefix(rv))}, ${sq(r.shardManifestSha256)}, ${sq(r.builtAt)}
  WHERE EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ${sq(rv)} AND state = 'stored')
  ON CONFLICT (version_id) DO UPDATE SET manifest_sha256 = excluded.manifest_sha256, built_at = excluded.built_at
  WHERE NOT EXISTS (SELECT 1 FROM rs_publication WHERE version_id = excluded.version_id AND state = 'published');`,
  ].join('\n') + '\n';
}

export interface Acknowledgement { code: string; count: number; reason: string }

/** One sign-off row, written only for the shard manifest this version is registered with. */
export function signoffSql(r: BuildRecord, a: { signer: string; at: string; acknowledgements: readonly Acknowledgement[] }): string {
  const rv = r.resultsVersion, v = r.version;
  const values = [rv, rv, v.manifestSha256, r.shardManifestSha256, v.validatorVersion, v.diagnosticsSha256, JSON.stringify(a.acknowledgements), a.signer, a.at];
  return `INSERT OR IGNORE INTO pub_version_signoff (version_id, results_version, manifest_sha256, shard_manifest_sha256, validator_version, diagnostics_sha256, acknowledgements_json, signer, signed_at)
  SELECT ${values.map(sq).join(', ')}
  WHERE EXISTS (SELECT 1 FROM rs_shard_manifest m JOIN rs_results_version v ON v.version_id = m.version_id
    WHERE m.version_id = ${sq(rv)} AND m.manifest_sha256 = ${sq(r.shardManifestSha256)} AND v.state = 'stored' AND v.case_id = ${sq(r.caseId)});\n`;
}

/**
 * The publication flip, one statement: the case's row points at the version only if a sign-off binds `remoteManifestSha256`
 * (the hash of the manifest R2 holds) and that is the version's registered shard manifest. The version it replaces becomes
 * `previous_version_id`; publishing the current version again changes nothing.
 */
export function publishSql(a: { caseId: string; resultsVersion: string; remoteManifestSha256: string; at: string }): string {
  const c = sq(a.caseId), rv = sq(a.resultsVersion), sha = sq(a.remoteManifestSha256);
  return `INSERT INTO rs_publication (case_id, state, version_id, previous_version_id, published_at)
  SELECT ${c}, 'published', ${rv}, NULL, ${sq(a.at)}
  WHERE EXISTS (SELECT 1 FROM pub_version_signoff s
      JOIN rs_shard_manifest m ON m.version_id = s.version_id AND m.manifest_sha256 = s.shard_manifest_sha256
      JOIN rs_results_version v ON v.version_id = s.version_id AND v.state = 'stored' AND v.case_id = ${c}
      WHERE s.version_id = ${rv} AND s.shard_manifest_sha256 = ${sha})
    AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = ${rv})
  ON CONFLICT (case_id) DO UPDATE SET
    previous_version_id = CASE WHEN rs_publication.version_id = excluded.version_id THEN rs_publication.previous_version_id ELSE rs_publication.version_id END,
    published_at = CASE WHEN rs_publication.version_id = excluded.version_id AND rs_publication.state = 'published' THEN rs_publication.published_at ELSE excluded.published_at END,
    state = 'published', version_id = excluded.version_id;\n`;
}

/** What `publish` reads back to confirm the flip. */
export const publicationQuery = (caseId: string) =>
  `SELECT p.state, p.version_id, p.previous_version_id, p.published_at, m.manifest_sha256 FROM rs_publication p LEFT JOIN rs_shard_manifest m ON m.version_id = p.version_id WHERE p.case_id = ${sq(caseId)}`;
