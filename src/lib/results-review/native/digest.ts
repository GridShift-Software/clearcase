// Hosted-safe hashing and identity derivation: Web Crypto and the library's browser-safe canonical JSON only. The package
// formulas (resultsVersion, inputRevision.id, manifestSha256) are NOT reimplemented here: they come from the case-package
// library through verifyCandidateBytes, so there is exactly one definition. These helpers hash only this module's own values
// (request digests, derived ids, the link digest), and tests prove they equal the library's sha256Hex over the same bytes.
import { canonicalJson } from '../../case-package/canonical.ts';
import { digest } from '../../shared/data.ts';

const encoder = new TextEncoder();
export const sha256Bytes = (bytes: Uint8Array): Promise<string> => digest(bytes);
export const sha256Text = (text: string): Promise<string> => digest(encoder.encode(text));
/** SHA-256 of the compact JCS encoding of a value: the library's identity encoding. */
export const sha256Canonical = (value: unknown): Promise<string> => sha256Text(canonicalJson(value));

/** The candidate instance of one stored results version: derived, so a retry can only ever name the same candidate. */
export async function candidateIdOf(a: { clientId: string; caseId: string; resultsVersion: string; manifestSha256: string }): Promise<string> {
  return `cand-${(await sha256Canonical({ clientId: a.clientId, caseId: a.caseId, resultsVersion: a.resultsVersion, manifestSha256: a.manifestSha256 })).slice(0, 32)}`;
}
/** The link of one candidate to one finalized submission revision and its stored manifest bytes. */
export async function linkIdOf(a: { candidateId: string; submissionRevisionId: string; submissionManifestSha256: string }): Promise<string> {
  return `link-${(await sha256Canonical({ candidateId: a.candidateId, submissionRevisionId: a.submissionRevisionId, submissionManifestSha256: a.submissionManifestSha256 })).slice(0, 32)}`;
}
