import { canonicalText } from '../case-package/canonical.ts';
import { digest } from '../server/runtime/data.ts';
import type { SubmissionManifest } from './ports.ts';

/**
 * The identity of one finalized submission snapshot: SHA-256 and length of the library's canonical text of its manifest
 * (`canonicalText`), `finalizedAt` included and unchanged. This is the one definition: the native snapshot reader hashes
 * it for the link and for readiness, and the operator view repeats it as `finalizedSnapshotSha256`. It is NOT the digest
 * of the bytes the operator manifest route serves (a fixed-key-order JSON text with its own `manifestSha256`).
 */
export async function finalizedSnapshotIdentity(m: SubmissionManifest): Promise<{ sha256: string; bytes: number }> {
  const bytes = new TextEncoder().encode(canonicalText(m));
  return { sha256: await digest(bytes), bytes: bytes.byteLength };
}
