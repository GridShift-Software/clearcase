// Narrow, read-only hosted extensions. They deliberately do not widen the shared CaseReader/runtime contract.
import type { CaseReader, VersionScope } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';

export interface OriginalAttribution { ref: string; assetId: string }
export interface PublishedReads {
  /** Authorize and recheck the exact publication, and load its digest/count-verified D1 model. No R2 or deep-work admission.
   * Throws integrity for a damaged model; availability/admission failures are not an integrity verdict. This is not a
   * replacement for verifyVersion's authoritative package/original byte check or serve-time original hashing. */
  publishedReadiness(scope: VersionScope): Promise<void>;
  /** Verified immutable row mapping + finalized case-relative path/fingerprint -> authorized original asset IDs. */
  originalAttributions(scope: VersionScope): Promise<readonly OriginalAttribution[]>;
}
export type PublishedCaseReader = CaseReader & PublishedReads;

// A parent composing a wrapper must forward these methods from createCloudReader unchanged. Missing hooks fail closed;
// never fall back to bounded deep verification or infer correspondence from a ref-shaped asset ID.
export async function publishedReadiness(store: CaseReader, scope: VersionScope): Promise<void> {
  const reader = store as Partial<PublishedReads>;
  if (typeof reader.publishedReadiness !== 'function') throw contractError('storage-unavailable', true);
  await reader.publishedReadiness(scope);
}
export async function originalAttributions(store: CaseReader, scope: VersionScope): Promise<readonly OriginalAttribution[]> {
  const reader = store as Partial<PublishedReads>;
  if (typeof reader.originalAttributions !== 'function') throw contractError('storage-unavailable', true);
  return reader.originalAttributions(scope);
}
