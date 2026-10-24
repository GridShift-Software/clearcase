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
 * Authentication, revocation and backend failures retain their own uniform 401/503 semantics.
 */
export type ClientUploadAuthorizer = ((intent: ClientUploadIntent) => Promise<void>) | null;

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

export interface RequiredOriginalLink {
  readonly packageRefs: readonly string[];
  readonly packagePath: string;
  readonly storedPath: string;
  readonly submissionAssetId: string;
  readonly sha256: Sha256;
  readonly size: number;
  /** Canonical unique path resolution records both spellings and preserves the warning. */
  readonly pathMatch: 'literal' | 'case-nfc-unique';
}

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
