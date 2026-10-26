/**
 * Native-alpha composition contracts only. No authorizer, grant writer, import endpoint,
 * persistence, publication permission or default implementation is supplied by this module.
 */
import type { CaseId, ClientId, Id, Principal, ResultsVersion, SessionId, Sha256 } from '../contracts.ts';
import type { SubmissionFile, SubmissionManifest } from '../../../submissions/ports.ts';

/** A distinct case capability, never inferred from case operations or operator capabilities. */
export type ClientUploadCapability = 'case.upload-originals';
/** The initial issuer is a trusted non-request provisioner; this does not implement its grant policy. */
export type InitialUploadGrantOwner = 'trusted-non-request-provisioning';
export interface ClientUploadIntent {
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly principal: Principal;
  readonly sessionId: SessionId;
}
/**
 * Trusted composition supplies a real-grant-backed function, otherwise null means unavailable (503).
 * A verified client or staff identity needs both explicit case access and an explicit upload grant.
 * Unknown and ungranted cases both throw forbidden (403), without a case/manifest/asset lookup.
 * A revoked or missing upload GRANT is indistinguishable from an unknown or ungranted one: the same
 * uniform forbidden (403), no metadata. Only an unauthenticated, expired or revoked SESSION/identity is 401.
 * Backend/verifier faults are 503, and so is an unconfigured authorizer (null); neither falls back to allow.
 */
export type ClientUploadAuthorizer = ((intent: ClientUploadIntent) => Promise<void>) | null;

/**
 * Caveat: the inherited `manifest.finalizedAt` currently records RESERVE time, not the final mark. It is not
 * proof of finalization or an SLA metric; trust `state: 'finalized'` from the reader. The property is unchanged.
 */
export type FrozenSubmissionManifest =
  Readonly<Omit<SubmissionManifest, 'files'>> & { readonly files: readonly Readonly<SubmissionFile>[] };

/** Produced by a trusted reader only after checking the upload row is finalized, not merely reserved. */
export interface FinalizedSubmissionSnapshot {
  readonly state: 'finalized';
  readonly manifest: FrozenSubmissionManifest;
  /** SHA-256 of the exact persisted manifest UTF-8 bytes; NOT the package inputRevision.id. */
  readonly storedManifestSha256: Sha256;
  readonly storedManifestBytes: number;
}

/** Identity read from validated, stored candidate bytes, never from a submitted identity claim. */
export interface PinnedPrivateCandidate {
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  /** Server-side candidate instance identity; does not replace a supplied package identity. */
  readonly candidateId: string;
  readonly resultsVersion: ResultsVersion;
  readonly manifestSha256: Sha256;
  readonly packageInputRevisionId: Id<'input-revision'>;
}

/**
 * Carrier for the EXISTING package warning ORIG_CASE_MISMATCH (case-package/codes.ts); this is not a new
 * warning, algorithm or waiver. Fingerprints are the package diagnostics' own, copied unchanged.
 */
export interface PreservedCaseMismatchWarning {
  readonly code: 'ORIG_CASE_MISMATCH';
  /** Every existing ORIG_CASE_MISMATCH diagnostic fingerprint for this original's package refs. */
  readonly fingerprints: readonly [string, ...string[]];
}

interface RequiredOriginalLinkBase {
  readonly packageRefs: readonly string[];
  readonly packagePath: string;
  readonly storedPath: string;
  readonly submissionAssetId: string;
  readonly sha256: Sha256;
  readonly size: number;
}

/**
 * A literal match needs no warning and none is invented. A case/NFC unique match records both spellings
 * and must carry the relevant existing ORIG_CASE_MISMATCH fingerprint(s); the link is not an acknowledgement.
 */
export type RequiredOriginalLink =
  | (RequiredOriginalLinkBase & { readonly pathMatch: 'literal' })
  | (RequiredOriginalLinkBase & {
      readonly pathMatch: 'case-nfc-unique';
      readonly preservedWarning: Readonly<PreservedCaseMismatchWarning>;
    });

export interface ImportLinkCoverage {
  readonly policy: 'exact-required-file-set/1';
  readonly mappedOriginals: readonly Readonly<RequiredOriginalLink>[];
  /** Canonical unavailable entries are explicit, never invented verified-byte mappings. */
  readonly unavailableOriginals: readonly (
    { readonly kind: 'missing'; readonly ref: string; readonly path: string } |
    { readonly kind: 'embedded'; readonly ref: string; readonly parentRef: string }
  )[];
}

/**
 * Private immutable server ledger shape. Readonly types are not an implementation of immutability:
 * a future repository must enforce write-once storage, verified retry readback and audit durability.
 */
export interface CandidateImportLink {
  readonly format: 'clearcase.candidate-import-link/1';
  readonly linkId: string;
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly submissionRevisionId: string;
  readonly submissionManifestSha256: Sha256;
  readonly candidate: Readonly<PinnedPrivateCandidate>;
  readonly coverage: Readonly<ImportLinkCoverage>;
  readonly operator: Readonly<Pick<Principal, 'issuer' | 'subject'> & { kind: 'staff' }>;
  readonly linkedAt: string;
  readonly attribution: 'manual-operator-link-not-processing-proof';
  readonly state: 'private-candidate-linked';
}

/** Publication must bind its existing exact-version checks to this link too; this grants no sign-off. */
export type ImportLinkSignoffBinding = Readonly<Pick<CandidateImportLink,
  'linkId' | 'clientId' | 'caseId' | 'submissionRevisionId' | 'submissionManifestSha256' | 'candidate'>>;
