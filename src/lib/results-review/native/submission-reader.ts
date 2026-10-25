import { canonicalText } from '../../case-package/canonical.ts';
import type { FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import { sha256 as brandSha } from '../../server/runtime/ids.ts';
import { revisionIdOf } from '../../submissions/repository.ts';
import type { SubmissionRepository } from '../../submissions/ports.ts';
import { sha256Bytes } from './digest.ts';
import type { FinalizedSubmissionReader } from './ports.ts';

/**
 * The finalized-submission reader over GRS-137's `SubmissionRepository`. It looks the revision up by its derived id among
 * the case's own uploads (never by a slug), and only the repository's `finalized` upload state yields a manifest, so a
 * reserved revision is `not-final` and an unknown revision, or another case's, is `absent`.
 *
 * The intake persists the manifest as immutable rows, not as one byte string. The "persisted bytes" hashed here are the
 * library's canonical text (`canonicalText`) of that manifest exactly as stored, `finalizedAt` included and unchanged
 * (it records reserve time; see alpha-contracts.ts). A future intake that stores manifest bytes replaces this adapter.
 */
export function submissionSnapshotReader(repository: Pick<SubmissionRepository, 'list'>): FinalizedSubmissionReader {
  return {
    async finalized(a) {
      const rows = await repository.list({ clientId: a.clientId, caseId: a.caseId });
      const hit = rows.find((r) => revisionIdOf(r.upload.operationId) === a.revisionId);
      if (!hit) return { state: 'absent' };
      const m = hit.manifest;
      if (!m || hit.upload.state !== 'finalized') return { state: 'not-final' };
      if (m.revisionId !== a.revisionId || m.clientId !== a.clientId || m.caseId !== a.caseId) return { state: 'absent' };
      const bytes = new TextEncoder().encode(canonicalText(m));
      const snapshot: FinalizedSubmissionSnapshot = { state: 'finalized', manifest: m, storedManifestSha256: brandSha(await sha256Bytes(bytes)), storedManifestBytes: bytes.byteLength };
      return snapshot;
    },
  };
}
