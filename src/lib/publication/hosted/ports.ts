import type { AuditSink, CaseId, ClientId, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import type { ImportLinkSignoffBinding } from '../../server/runtime/hosted/alpha-contracts.ts';

// Native exact-version sign-off and publication (ADR-0010). Ports only: the parent composition supplies each one from
// trusted configuration. A missing port answers 503; nothing here supplies a default, a double, an allow or a role.

/** One required analysis section of a candidate, as the candidate reader found it after validation and display. */
export type RequiredSectionState = 'valid' | 'invalid' | 'unsupported' | 'missing';
/** One required file preview of a candidate (ADR-0011): only `rendered` counts; a failed or pending preview holds the update. */
export type RequiredPreviewState = 'rendered' | 'failed' | 'pending';

/**
 * What a trusted reader returns for one private candidate. These are facts, never a verdict: there is deliberately no
 * `ready` flag, and a snapshot carrying any key not listed here is refused as unreadable (503), not trusted.
 */
export interface CandidateSnapshot {
  /** The immutable import link (alpha-contracts), with the pinned server candidate it binds. */
  readonly link: ImportLinkSignoffBinding;
  /** Who prepared the candidate (the link operator), so a self-approval is recognised and recorded as such. */
  readonly preparedBy: Readonly<Pick<Principal, 'issuer' | 'subject'>>;
  /** Changes on every saved reviewer correction or re-stage of this candidate. A sign-off binds it exactly. */
  readonly snapshotRevision: string;
  readonly validation: Readonly<{
    verdict: 'accept' | 'report' | 'reject';
    validatorVersion: string;
    diagnosticsSha256: string;
    errorFingerprints: readonly string[];
    warningFingerprints: readonly string[];
  }>;
  /** Warning fingerprints already accepted for this case (the published version's accepted set). Never from a package. */
  readonly trustedBaseline: readonly string[];
  readonly requiredSections: readonly Readonly<{ key: string; state: RequiredSectionState }>[];
  readonly requiredPreviews: readonly Readonly<{ assetId: string; state: RequiredPreviewState }>[];
}

/** Reads one private candidate of this deployment's client. Null: no such candidate. A fault rejects (503). */
export interface CandidateReader {
  read(a: { clientId: ClientId; caseId: CaseId; candidateId: string }): Promise<unknown>;
}

/** The case's publication pointer as GRS-115 storage holds it (rs_publication / rs_version_withdrawal). */
export type PublicationState =
  | { readonly kind: 'none' }
  | { readonly kind: 'published'; readonly resultsVersion: ResultsVersion }
  | { readonly kind: 'withdrawn'; readonly resultsVersion: ResultsVersion };

export type PointerOutcome =
  | { kind: 'applied'; repeated: boolean }
  /** The pointer is not what the caller expected; nothing changed. */
  | { kind: 'conflict'; current: PublicationState }
  /** Storage refused for its own reason (unknown or unstored version, another case's version); nothing changed. */
  | { kind: 'refused'; reason: string };

/**
 * The storage publisher (GRS-115 pointer owner). Each call is one guarded, atomic compare-and-set on the case's
 * publication pointer: it applies only when the pointer equals `expected`, and otherwise changes nothing. It never
 * deletes or rewrites a results version, an original or user work, and it never rolls anything back by deletion. A
 * fault rejects; a rejection leaves the previous pointer in place.
 */
export interface StoragePublisher {
  publish(a: { caseId: CaseId; resultsVersion: ResultsVersion; manifestSha256: string; expected: PublicationState; operationId: string }): Promise<PointerOutcome>;
  /** Withdraws results only: the pointer becomes withdrawn and the version unreadable; originals and user work are untouched. */
  withdraw(a: { caseId: CaseId; resultsVersion: ResultsVersion; expected: PublicationState; operationId: string }): Promise<PointerOutcome>;
}

/**
 * Explicit case publication authority from GRS-114 grants (structurally `AuthorizeCapability` narrowed to `publish`).
 * Staff, global-admin or client identity alone never implies it. Rejects with a contract error to refuse.
 */
export type AuthorizePublication = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; capability: 'publish' }) => Promise<void>;

export interface SignoffAcknowledgement { readonly fingerprint: string; readonly reason: string }
/** The exact identity a sign-off binds; every field is compared again before publication. */
export interface SignoffIdentity {
  readonly candidateId: string;
  readonly linkId: string;
  readonly submissionRevisionId: string;
  readonly submissionManifestSha256: string;
  readonly resultsVersion: ResultsVersion;
  readonly manifestSha256: string;
  readonly packageInputRevisionId: string;
  readonly diagnosticsSha256: string;
  readonly validatorVersion: string;
  readonly snapshotRevision: string;
}
export interface SignoffRecord extends SignoffIdentity {
  readonly signoffId: string;
  readonly operationId: string;
  readonly requestSha256: string;
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly warningFingerprints: readonly string[];
  readonly acknowledgements: readonly SignoffAcknowledgement[];
  readonly signer: Readonly<Pick<Principal, 'issuer' | 'subject' | 'kind'>>;
  readonly preparedBy: Readonly<Pick<Principal, 'issuer' | 'subject'>>;
  /** The signer prepared the candidate and confirmed approving their own work in this separate recorded action. */
  readonly selfApproval: boolean;
  readonly signedAt: string;
  /** recorded: written, its audit event not yet confirmed; audited: effective. Only an audited sign-off can publish. */
  readonly state: 'recorded' | 'audited';
  readonly invalidatedAt: string | null;
  readonly invalidatedReason: string | null;
}

export type OperationKind = 'publish' | 'withdraw';
export type OperationState = 'pending' | 'applied' | 'refused' | 'failed' | 'audited';
export interface OperationRecord {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly kind: OperationKind;
  readonly signoffId: string | null;
  readonly resultsVersion: ResultsVersion;
  readonly expected: PublicationState;
  readonly actor: Readonly<Pick<Principal, 'issuer' | 'subject' | 'kind'>>;
  readonly state: OperationState;
  readonly reason: string | null;
  readonly at: string;
}

/** The durable sign-off and publication ledger (namespace `pub_*`). Write-once rows; only the listed transitions. */
export interface PublicationLedger {
  recordSignoff(r: SignoffRecord): Promise<{ kind: 'recorded'; record: SignoffRecord; repeated: boolean } | { kind: 'operation-reused' }>;
  signoff(a: { clientId: ClientId; caseId: CaseId; signoffId: string }): Promise<SignoffRecord | null>;
  settleSignoff(a: { clientId: ClientId; caseId: CaseId; signoffId: string }): Promise<void>;
  invalidateSignoff(a: { clientId: ClientId; caseId: CaseId; signoffId: string; at: string; reason: string }): Promise<void>;
  operation(a: { clientId: ClientId; caseId: CaseId; operationId: string }): Promise<OperationRecord | null>;
  beginOperation(r: OperationRecord): Promise<{ kind: 'begun'; record: OperationRecord; repeated: boolean } | { kind: 'operation-reused' }>;
  finishOperation(a: { clientId: ClientId; caseId: CaseId; operationId: string; state: 'applied' | 'refused' | 'failed'; reason: string | null }): Promise<void>;
  settleOperation(a: { clientId: ClientId; caseId: CaseId; operationId: string }): Promise<void>;
}

/** Everything the publication controller needs; the parent composes it per request. A null port answers 503. */
export interface NativePublicationPorts {
  readonly clientId: ClientId;
  readonly authorize: AuthorizePublication | null;
  readonly candidates: CandidateReader | null;
  readonly publisher: StoragePublisher | null;
  readonly ledger: PublicationLedger | null;
  readonly audit: AuditSink | null;
  now(): Date;
}
