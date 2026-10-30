import type { CaseId, CaseInfo, Identity, Principal, PublicationRecord, OverviewNoteSummary } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { contractError } from '../server/runtime/errors.ts';
import { id, resultsVersion } from '../server/runtime/ids.ts';
import { USER_WORK_SCHEMA_VERSION } from '../user-work/hosted/d1-user-work.ts';
import { admittedShards } from '../results/hosted/versions.ts';
import { LAYOUT } from '../storage/cloud/gate.ts';
import type { ClientResourceIdentity } from './manifest.ts';
import type { OriginalRow } from '../viewer/hosted/fast-original.ts';
import { PAGE_NOTE_STORE } from '../viewer/hosted/page-notes.ts';
import type { GrantRecord } from './grants.ts';
import { parseGrant, GRANT_COLUMNS } from './d1-grants.ts';

export interface RequestCase {
  grants: readonly GrantRecord[];
  exists: boolean;
  info: CaseInfo | null;
  published: PublicationRecord | null;
  workBound: boolean;
  overviewNotes: OverviewNoteSummary | null;
  original: (Omit<OriginalRow, 'etag' | 'mediaFamily'> & { etag: string | null; mediaFamily: string | null }) | null;
}

type CaseRow = Parameters<typeof parseGrant>[0] & {
  row_kind: 'case'; work_bound: number; case_label: string | null; pub_state: string | null; pub_version: string | null;
  published_at: string | null; previous_version_id: string | null; stored: string | null; withdrawn: string | null;
  manifest_sha256: string | null; admitted_json: string | null; original_sha256: string | null; original_size: number;
  original_etag: string | null; original_key: string; media_family: string | null; filename: string; media_type: string;
};
type OverviewRow = Omit<CaseRow, 'row_kind'> & {
  row_kind: 'overview'; total: number; here: number; exact: number; ambiguous: number; missing: number; unanchored: number; page_notes: number;
};
type RefRow = { row_kind: 'ref'; ref: string; ref_count: number; ref_status: OverviewNoteSummary['byRef'][number]['status'] };

/**
 * Every live case grant of one principal in this client's database, and which of their cases exist here, in one
 * statement: the grant read of `d1GrantRepository.grantsOf` for all cases at once, and `d1CaseDirectory`'s existence rule
 * (this deployment's client and layout bound, and the case row present).
 */
export function principalCaseGrants(db: D1, deployment: ClientResourceIdentity) {
  return async (principal: Principal): Promise<{ grants: readonly GrantRecord[]; present: ReadonlySet<string> }> => {
    const { results } = await db.prepare(`SELECT ${GRANT_COLUMNS.split(', ').map(c => `g.${c}`).join(', ')},
      i.client_id = ? AND i.layout = ? AND c.case_id IS NOT NULL AS present
      FROM tenant_case_grants g INDEXED BY tenant_case_grants_principal
      LEFT JOIN rs_storage_identity i ON i.singleton = 1
      LEFT JOIN rs_case c ON c.case_id = g.case_id
      WHERE g.client_id = ? AND g.issuer = ? AND g.subject = ? AND g.scope = 'case' AND g.state <> 'revoked'`)
      .bind(deployment.clientId, LAYOUT, deployment.clientId, principal.issuer, principal.subject)
      .all<Parameters<typeof parseGrant>[0] & { present: number | null }>();
    return { grants: results.map(parseGrant), present: new Set(results.filter(r => r.present === 1).map(r => r.case_id!)) };
  };
}

/** One primary-session snapshot per case and verified principal, owned by one request only. */
export function requestCaseLookup(db: D1, deployment: ClientResourceIdentity, assetId: string | null = null, profile: 'case' | 'overview' = 'case') {
  const memo = new Map<string, Promise<RequestCase>>();
  const request = (a: { principal: NonNullable<Identity['principal']>; caseId: CaseId }): Promise<RequestCase> => {
    const key = JSON.stringify([a.principal.issuer, a.principal.subject, a.principal.kind, a.caseId]);
    let pending = memo.get(key);
    if (!pending) {
      pending = lookup(a);
      memo.set(key, pending);
    }
    return pending;
  };
  return Object.assign(request, { profile });
  async function lookup(a: { principal: NonNullable<Identity['principal']>; caseId: CaseId }): Promise<RequestCase> {
    const base = `SELECT ${GRANT_COLUMNS.split(', ').map(c => `g.${c}`).join(', ')},
      EXISTS (SELECT 1 FROM uw_binding WHERE singleton = 1 AND client_id = g.client_id AND schema_version = ?) AS work_bound,
      COALESCE(c.case_label, v.case_label) AS case_label, p.state AS pub_state, p.version_id AS pub_version, p.published_at, p.previous_version_id,
      v.state AS stored, w.version_id AS withdrawn, m.manifest_sha256, m.admitted_json,
      o.sha256 AS original_sha256, o.size AS original_size, o.etag AS original_etag, o.object_key AS original_key,
      o.media_family, co.filename, co.media_type
      FROM tenant_case_grants g INDEXED BY tenant_case_grants_principal
      JOIN rs_storage_identity i ON i.singleton = 1 AND i.client_id = g.client_id AND i.layout = ?
      JOIN rs_case c ON c.case_id = g.case_id
      LEFT JOIN rs_publication p ON p.case_id = c.case_id
      LEFT JOIN rs_results_version v ON v.version_id = p.version_id AND v.case_id = c.case_id
      LEFT JOIN rs_version_withdrawal w ON w.version_id = p.version_id
      LEFT JOIN rs_shard_manifest m ON m.version_id = p.version_id
      LEFT JOIN rs_case_original co ON co.case_id = c.case_id AND co.asset_id = ?
      LEFT JOIN rs_original o ON o.sha256 = co.sha256
      WHERE g.client_id = ? AND g.issuer = ? AND g.subject = ? AND g.principal_kind = ?
      AND g.scope = 'case' AND g.case_id = ? AND g.state = 'active'`;
    const { results } = await db.prepare(profile === 'overview' ? overviewQuery(base) : `SELECT 'case' AS row_kind, s.* FROM (${base}) s`)
      .bind(USER_WORK_SCHEMA_VERSION, LAYOUT, assetId, deployment.clientId, a.principal.issuer, a.principal.subject, a.principal.kind, a.caseId)
      .all<CaseRow | OverviewRow | RefRow>()
      .catch(() => { throw contractError('identity-unavailable', true); });
    const snapshots = results.filter(row => row.row_kind !== 'ref');
    const r = snapshots[0];
    if (!r) return { grants: [], exists: false, info: null, published: null, workBound: false, overviewNotes: null, original: null };
    const published = r.pub_state === 'published' && r.pub_version && r.stored === 'stored' && !r.withdrawn
      ? { versionId: resultsVersion(r.pub_version), publishedAt: r.published_at, previousVersionId: r.previous_version_id ? resultsVersion(r.previous_version_id) : null, shardManifestSha256: r.manifest_sha256, shards: admittedShards(r.admitted_json) } : null;
    return { grants: snapshots.map(parseGrant), exists: true, published, workBound: r.work_bound === 1,
      overviewNotes: r.row_kind === 'overview' ? { total: r.total, here: r.here, exact: r.exact, ambiguous: r.ambiguous, missing: r.missing, unanchored: r.unanchored, pageNotes: r.page_notes,
        byRef: results.filter(row => row.row_kind === 'ref').map(row => ({ ref: row.ref, n: row.ref_count, status: row.ref_status })) } : null,
      original: assetId && r.original_sha256 ? { caseId: a.caseId, assetId, sha256: r.original_sha256, size: r.original_size, etag: r.original_etag, objectKey: r.original_key, mediaFamily: r.media_family, filename: r.filename, mediaType: r.media_type, clientId: deployment.clientId, issuer: a.principal.issuer, subject: a.principal.subject } : null,
      info: { caseId: id('case', a.caseId), caseLabel: r.case_label, href: `/cases/${encodeURIComponent(a.caseId)}`, documents: null,
        publication: published ? { kind: 'published', resultsVersion: published.versionId } : { kind: r.pub_state === null ? 'none' : 'withdrawn' } } };
  }
}

/** Separate snapshots and counted refs, so publication metadata never multiplies by refs or refs by grants.
 * Ordering preserves summary's first-note status and first-seen ref order, including ambiguous matches. */
function overviewQuery(base: string): string {
  return `WITH snapshot AS (${base}),
    targets AS (
      SELECT n.rowid AS seq, json_extract(n.target_json, '$.kind') AS kind,
        json_extract(n.target_json, '$.anchor.resultsVersion') AS version,
        json_extract(n.target_json, '$.anchor.refAtCreation') AS ref,
        json_extract(n.target_json, '$.anchor.sha256') AS sha, s.pub_version
      FROM uw_note n JOIN (SELECT case_id, pub_version FROM snapshot
        WHERE work_bound = 1 AND pub_state = 'published' AND stored = 'stored' AND withdrawn IS NULL LIMIT 1) s ON s.case_id = n.case_id
    ), matches AS (
      SELECT n.seq, d.ref FROM targets n JOIN rs_document d ON d.version_id = n.pub_version
        AND json_extract(d.state_json, '$.original.sha256') = n.sha
      WHERE n.kind = 'document' AND n.version <> n.pub_version AND n.sha IS NOT NULL AND n.sha <> ''
    ), statuses AS (
      SELECT n.*, CASE WHEN kind = 'case' THEN 'here'
        WHEN kind <> 'document' THEN 'unanchored'
        WHEN version = pub_version THEN 'here'
        WHEN sha IS NULL OR sha = '' THEN 'unanchored'
        WHEN (SELECT COUNT(*) FROM matches m WHERE m.seq = n.seq) = 0 THEN 'missing'
        WHEN (SELECT COUNT(*) FROM matches m WHERE m.seq = n.seq) = 1 THEN 'exact'
        ELSE 'ambiguous' END AS status FROM targets n
    ), note_refs AS (
      SELECT seq, ref FROM statuses WHERE kind = 'document' AND status = 'here'
      UNION ALL SELECT seq, ref FROM matches
    ), ref_counts AS (
      SELECT ref, COUNT(*) AS ref_count, MIN(seq) AS first_note FROM note_refs GROUP BY ref
    ), totals AS (
      SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'here' THEN 1 END) AS here,
        COUNT(CASE WHEN status = 'exact' THEN 1 END) AS exact, COUNT(CASE WHEN status = 'ambiguous' THEN 1 END) AS ambiguous,
        COUNT(CASE WHEN status = 'missing' THEN 1 END) AS missing, COUNT(CASE WHEN status = 'unanchored' THEN 1 END) AS unanchored
      FROM statuses
    )
    SELECT 'overview' AS row_kind, s.*, t.*,
      (SELECT COUNT(*) FROM uw_register_row WHERE case_id = s.case_id AND store = '${PAGE_NOTE_STORE}') AS page_notes,
      NULL AS ref, NULL AS ref_count, NULL AS ref_status, NULL AS first_note
    FROM snapshot s CROSS JOIN totals t
    UNION ALL
    SELECT 'ref' AS row_kind, s.*, t.*, NULL AS page_notes, r.ref, r.ref_count, n.status AS ref_status, r.first_note
    FROM ref_counts r JOIN statuses n ON n.seq = r.first_note
      -- Nonmatching joins supply NULL columns for the UNION without repeating any snapshot or totals values.
      LEFT JOIN snapshot s ON 0 LEFT JOIN totals t ON 0
    ORDER BY first_note, ref`;
}
