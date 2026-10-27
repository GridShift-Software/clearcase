import { contractError } from '../../server/runtime/errors.ts';
import type { FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { sha256 as brandSha } from '../../server/runtime/ids.ts';
import { revisionIdOf } from '../../submissions/repository.ts';
import { finalizedSnapshotIdentity } from '../../submissions/snapshot-identity.ts';
import { fileSetDigest } from '../../submissions/file-set.ts';
import type { SubmissionManifest } from '../../submissions/ports.ts';
import type { FinalizedSubmissionReader, NativeD1 } from './ports.ts';

const PREFIX = revisionIdOf('');
type Row = { state: string; revision_id: string | null; sequence: number; operation_id: string; finalized_at: string; path: string | null; filename: string; media_type: string; size: number; sha256: string; asset_id: string };

/**
 * The finalized-submission reader over GRS-137's intake rows (migrations `0001_submissions_intake.sql` and, for sets,
 * `0002_submissions_file_sets.sql`). A revision id is derived from its upload's or its set's operation id, so the upload or the
 * set is found by that id within this client's and case's rows (never by a slug), in one statement with its revision and
 * files. Only a `finalized` upload or a `sealed` set yields a manifest: a reserved revision or a set still sealing is
 * `not-final`, and an unknown revision, or another case's, is `absent`.
 *
 * The intake persists the manifest as immutable rows, not as one byte string. The "persisted bytes" hashed here are the
 * library's canonical text (`canonicalText`) of that manifest exactly as `SubmissionRepository.revision` builds it,
 * `finalizedAt` included and unchanged (it records reserve time; see alpha-contracts.ts). `finalizedSnapshotIdentity`
 * is the one definition, shared with the operator submission view. A future intake that stores manifest bytes replaces
 * this adapter.
 */
export function submissionSnapshotReader(db: NativeD1): FinalizedSubmissionReader {
  const snapshot = async (m: SubmissionManifest): Promise<FinalizedSubmissionSnapshot> => {
    const identity = await finalizedSnapshotIdentity(m);
    return { state: 'finalized', manifest: m, storedManifestSha256: brandSha(identity.sha256), storedManifestBytes: identity.bytes };
  };
  // A multi-file revision (U16): the set's id is the revision's operation. Only a sealed set yields a manifest, and only when
  // its files are exactly the declared count and hash to the digest fixed at the seal.
  async function set(a: { clientId: string; caseId: string; revisionId: string }, setId: string): Promise<Awaited<ReturnType<FinalizedSubmissionReader['finalized']>>> {
    const { results: rows } = await db.prepare(`SELECT s.state, s.file_count, s.files_sha256, r.revision_id, r.sequence, r.operation_id, r.finalized_at, f.path, f.filename, f.media_type, f.size, f.sha256, f.asset_id
      FROM submissions_set s
      LEFT JOIN submissions_revision r ON r.client_id = s.client_id AND r.case_id = s.case_id AND r.operation_id = s.set_id
      LEFT JOIN submissions_file f ON f.client_id = r.client_id AND f.case_id = r.case_id AND f.revision_id = r.revision_id
      WHERE s.client_id = ? AND s.case_id = ? AND s.set_id = ? ORDER BY f.path_key`)
      .bind(a.clientId, a.caseId, setId).all<Row & { file_count: number; files_sha256: string | null }>().catch(() => { throw contractError('storage-unavailable', true); });
    if (rows.length === 0) return { state: 'absent' };
    const r = rows[0]!;
    if (r.state !== 'sealed' || r.revision_id !== a.revisionId) return { state: 'not-final' };
    const files = rows.map((f) => Object.freeze({ path: f.path!, filename: f.filename, mediaType: f.media_type, size: f.size, sha256: f.sha256, assetId: f.asset_id }));
    if (rows.some((f) => f.path === null) || files.length !== r.file_count || (await fileSetDigest(files)) !== r.files_sha256) throw contractError('storage-unavailable', true);
    return snapshot(Object.freeze({
      format: 'clearcase.submission-manifest/1' as const, clientId: a.clientId as ClientId, caseId: a.caseId as CaseId,
      revisionId: r.revision_id, sequence: r.sequence, operationId: r.operation_id, finalizedAt: r.finalized_at, files: Object.freeze(files),
    }));
  }
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
      if (revisionIdOf(operationId) !== a.revisionId) return { state: 'absent' };
      if (rows.length === 0) return set(a, operationId);
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
      return snapshot(m);
    },
  };
}
