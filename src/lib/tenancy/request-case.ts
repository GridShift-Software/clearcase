import type { CaseId, CaseInfo, Identity, Principal, PublicationRecord } from '../server/runtime/contracts.ts';
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
  notesJson: string;
  /** the case's stored page notes (the viewer's register rows), counted by the primary key, none decoded */
  pageNotes: number;
  fingerprintsJson: string;
  original: (Omit<OriginalRow, 'etag' | 'mediaFamily'> & { etag: string | null; mediaFamily: string | null }) | null;
}

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
export function requestCaseLookup(db: D1, deployment: ClientResourceIdentity, assetId: string | null = null) {
  const memo = new Map<string, Promise<RequestCase>>();
  return (a: { principal: NonNullable<Identity['principal']>; caseId: CaseId }): Promise<RequestCase> => {
    const key = JSON.stringify([a.principal.issuer, a.principal.subject, a.principal.kind, a.caseId]);
    let pending = memo.get(key);
    if (!pending) {
      pending = lookup(a);
      memo.set(key, pending);
    }
    return pending;
  };
  async function lookup(a: { principal: NonNullable<Identity['principal']>; caseId: CaseId }): Promise<RequestCase> {
    const { results } = await db.prepare(`SELECT ${GRANT_COLUMNS.split(', ').map(c => `g.${c}`).join(', ')},
      EXISTS (SELECT 1 FROM uw_binding WHERE singleton = 1 AND client_id = g.client_id AND schema_version = ?) AS work_bound,
      COALESCE(c.case_label, v.case_label) AS case_label, p.state AS pub_state, p.version_id AS pub_version, p.published_at, p.previous_version_id,
      v.state AS stored, w.version_id AS withdrawn, m.manifest_sha256, m.admitted_json,
      (SELECT json_group_array(json_object('id', note_id, 'body', body, 'bodySha256', body_sha256, 'target', json(target_json), 'createdAt', created_at, 'version', version)) FROM (SELECT * FROM uw_note WHERE case_id = c.case_id ORDER BY rowid)) AS notes_json,
      (SELECT COUNT(*) FROM uw_register_row WHERE case_id = c.case_id AND store = ?) AS page_notes,
      (SELECT json_group_array(json_object('ref', ref, 'sha256', json_extract(state_json, '$.original.sha256'))) FROM rs_document WHERE version_id = p.version_id AND EXISTS (SELECT 1 FROM uw_note WHERE case_id = c.case_id AND json_extract(target_json, '$.kind') = 'document' AND json_extract(target_json, '$.anchor.resultsVersion') <> p.version_id)) AS fingerprints_json,
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
      AND g.scope = 'case' AND g.case_id = ? AND g.state = 'active'`)
      .bind(USER_WORK_SCHEMA_VERSION, PAGE_NOTE_STORE, LAYOUT, assetId, deployment.clientId, a.principal.issuer, a.principal.subject, a.principal.kind, a.caseId)
      .all<Parameters<typeof parseGrant>[0] & { work_bound: number; case_label: string | null; pub_state: string | null; pub_version: string | null; published_at: string | null; previous_version_id: string | null; stored: string | null; withdrawn: string | null; manifest_sha256: string | null; admitted_json: string | null; notes_json: string; page_notes: number; fingerprints_json: string; original_sha256: string | null; original_size: number; original_etag: string | null; original_key: string; media_family: string; filename: string; media_type: string }>()
      .catch(() => { throw contractError('identity-unavailable', true); });
    const r = results[0];
    if (!r) return { grants: [], exists: false, info: null, published: null, workBound: false, notesJson: '[]', pageNotes: 0, fingerprintsJson: '[]', original: null };
    const published = r.pub_state === 'published' && r.pub_version && r.stored === 'stored' && !r.withdrawn
      ? { versionId: resultsVersion(r.pub_version), publishedAt: r.published_at, previousVersionId: r.previous_version_id ? resultsVersion(r.previous_version_id) : null, shardManifestSha256: r.manifest_sha256, shards: admittedShards(r.admitted_json) } : null;
    return { grants: results.map(parseGrant), exists: true, published, workBound: r.work_bound === 1, notesJson: r.notes_json, pageNotes: r.page_notes, fingerprintsJson: r.fingerprints_json,
      original: assetId && r.original_sha256 ? { caseId: a.caseId, assetId, sha256: r.original_sha256, size: r.original_size, etag: r.original_etag, objectKey: r.original_key, mediaFamily: r.media_family, filename: r.filename, mediaType: r.media_type, clientId: deployment.clientId, issuer: a.principal.issuer, subject: a.principal.subject } : null,
      info: { caseId: id('case', a.caseId), caseLabel: r.case_label, href: `/cases/${encodeURIComponent(a.caseId)}`, documents: null,
        publication: published ? { kind: 'published', resultsVersion: published.versionId } : { kind: r.pub_state === null ? 'none' : 'withdrawn' } } };
  }
}
