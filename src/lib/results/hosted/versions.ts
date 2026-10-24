import type { CaseId, CaseInfo, Publication, ResultsVersion, VersionInfo } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { id, resultsVersion } from '../../server/runtime/ids.ts';
import type { CloudD1 } from '../../storage/cloud/bindings.ts';

export const unavailable = (): never => { throw contractError('storage-unavailable', true); };
export const forbidden = () => contractError('forbidden');

type CaseRow = { case_id: string; case_label: string | null; pub_state: 'published' | 'withdrawn' | null; pub_version: string | null; withdrawn: string | null; stored: string | null };
const CASE_SQL = `SELECT c.case_id, c.case_label, p.state AS pub_state, p.version_id AS pub_version, w.version_id AS withdrawn, v.state AS stored
  FROM rs_case c LEFT JOIN rs_publication p ON p.case_id = c.case_id LEFT JOIN rs_version_withdrawal w ON w.version_id = p.version_id
  LEFT JOIN rs_results_version v ON v.version_id = p.version_id AND v.case_id = c.case_id`;

/**
 * A case's publication as clients may see it. Published means: the pointer says published, the version is a stored
 * version of this case, and no withdrawal names it. A withdrawal binds whatever the pointer says.
 */
function publication(r: CaseRow): Publication {
  if (r.pub_state === 'published' && r.pub_version && r.stored === 'stored' && !r.withdrawn) return { kind: 'published', resultsVersion: resultsVersion(r.pub_version) };
  return { kind: r.pub_state === null ? 'none' : 'withdrawn' };
}
const info = (r: CaseRow): CaseInfo => ({ caseId: id('case', r.case_id), caseLabel: r.case_label, publication: publication(r), href: `/cases/${encodeURIComponent(r.case_id)}`, documents: null });

export async function caseRows(db: CloudD1): Promise<CaseInfo[]> {
  const { results } = await db.prepare(`${CASE_SQL} ORDER BY c.case_id`).all<CaseRow>().catch(unavailable);
  return results.map(info);
}
export async function caseRow(db: CloudD1, caseId: CaseId): Promise<CaseInfo | null> {
  const r = await db.prepare(`${CASE_SQL} WHERE c.case_id = ?`).bind(caseId).first<CaseRow>().catch(unavailable);
  return r ? info(r) : null;
}
/** The exact published version of `caseId`, or a refusal: a candidate, a staging version and a withdrawn one are forbidden alike. */
export async function requirePublished(db: CloudD1, caseId: CaseId, rv: ResultsVersion): Promise<void> {
  const c = await caseRow(db, caseId);
  if (c?.publication.kind !== 'published' || c.publication.resultsVersion !== rv) throw forbidden();
}

type VersionRow = {
  version_id: string; case_id: string; case_label: string | null; input_revision_id: string; created: string; import_seq: number; verdict: string; stored_at: string;
  manifest_sha256: string; diagnostics_sha256: string; validator_version: string; warning_fingerprints: string; expected_documents: number; expected_assets: number;
  expected_seeds: number; expected_files: number; read_model_sha256: string; overview: string;
};
export async function caseOfVersion(db: CloudD1, rv: ResultsVersion): Promise<CaseId | null> {
  const r = await db.prepare('SELECT case_id FROM rs_results_version WHERE version_id = ?').bind(rv).first<{ case_id: string }>().catch(unavailable);
  return r ? id('case', r.case_id) : null;
}
export async function versionInfo(db: CloudD1, rv: ResultsVersion): Promise<VersionInfo | null> {
  const r = await db.prepare("SELECT * FROM rs_results_version WHERE version_id = ? AND state = 'stored'").bind(rv).first<VersionRow>().catch(unavailable);
  if (!r) return null;
  return {
    id: resultsVersion(r.version_id), case_id: id('case', r.case_id), case_label: r.case_label, input_revision_id: id('input-revision', r.input_revision_id),
    created: r.created, import_id: r.import_seq, verdict: r.verdict, stored_at: r.stored_at, manifest_sha256: r.manifest_sha256, diagnostics_sha256: r.diagnostics_sha256,
    validator_version: r.validator_version, warning_fingerprints: r.warning_fingerprints, read_model_sha256: r.read_model_sha256, overview: r.overview,
    expect: JSON.stringify({ documents: r.expected_documents, assets: r.expected_assets, seeds: r.expected_seeds, files: r.expected_files }),
  };
}
