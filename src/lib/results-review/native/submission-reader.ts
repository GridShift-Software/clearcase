import { canonicalText } from '../../case-package/canonical.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { sha256 as brandSha } from '../../server/runtime/ids.ts';
import { revisionIdOf } from '../../submissions/repository.ts';
import type { SubmissionManifest } from '../../submissions/ports.ts';
import { sha256Bytes } from './digest.ts';
import type { FinalizedSubmissionReader, NativeD1 } from './ports.ts';

const PREFIX = revisionIdOf('');
type Row = { state: string; revision_id: string | null; sequence: number; operation_id: string; finalized_at: string; path: string | null; filename: string; media_type: string; size: number; sha256: string; asset_id: string };

/**
 * The finalized-submission reader over GRS-137's intake rows (migration `0001_submissions_intake.sql`). A revision id is
 * derived from its upload's operation id, so the one upload is found by that id within this client's and case's rows (never
 * by a slug), in one statement with its revision and file. Only a `finalized` upload yields a manifest: a reserved revision
 * is `not-final`, and an unknown revision, or another case's, is `absent`.
 *
 * The intake persists the manifest as immutable rows, not as one byte string. The "persisted bytes" hashed here are the
 * library's canonical text (`canonicalText`) of that manifest exactly as `SubmissionRepository.revision` builds it,
 * `finalizedAt` included and unchanged (it records reserve time; see alpha-contracts.ts). A future intake that stores
 * manifest bytes replaces this adapter.
 */
export function submissionSnapshotReader(db: NativeD1): FinalizedSubmissionReader {
  return {
    async finalized(a) {
      if (typeof a.revisionId !== 'string' || !a.revisionId.startsWith(PREFIX)) return { state: 'absent' };
      const operationId = a.revisionId.slice(PREFIX.length);
      const { results: rows } = await db.prepare(`SELECT u.state AS state, r.revision_id, r.sequence, r.operation_id, r.finalized_at, f.path, f.filename, f.media_type, f.size, f.sha256, f.asset_id
        FROM submissions_upload u
        LEFT JOIN submissions_revision r ON r.client_id = u.client_id AND r.case_id = u.case_id AND r.operation_id = u.operation_id
        LEFT JOIN submissions_file f ON f.client_id = r.client_id AND f.case_id = r.case_id AND f.revision_id = r.revision_id
        WHERE u.client_id = ? AND u.case_id = ? AND u.operation_id = ? ORDER BY f.path_key`)
        .bind(a.clientId, a.caseId, operationId).all<Row>().catch(() => { throw contractError('storage-unavailable', true); });
      if (rows.length === 0 || revisionIdOf(operationId) !== a.revisionId) return { state: 'absent' };
      const r = rows[0]!;
      if (r.state !== 'finalized' || r.revision_id === null) return { state: 'not-final' };
      // A revision without its file is not a recorded submission; the intake writes both or neither.
      if (rows.some((f) => f.path === null)) throw contractError('storage-unavailable', true);
      const m: SubmissionManifest = Object.freeze({
        format: 'clearcase.submission-manifest/1' as const, clientId: a.clientId as ClientId, caseId: a.caseId as CaseId,
        revisionId: r.revision_id, sequence: r.sequence, operationId: r.operation_id, finalizedAt: r.finalized_at,
        files: Object.freeze(rows.map((f) => Object.freeze({ path: f.path!, filename: f.filename, mediaType: f.media_type, size: f.size, sha256: f.sha256, assetId: f.asset_id }))),
      });
      if (m.revisionId !== a.revisionId) return { state: 'absent' };
      const bytes = new TextEncoder().encode(canonicalText(m));
      const snapshot: FinalizedSubmissionSnapshot = { state: 'finalized', manifest: m, storedManifestSha256: brandSha(await sha256Bytes(bytes)), storedManifestBytes: bytes.byteLength };
      return snapshot;
    },
  };
}
