import type { AuditEvent, AuditSink, CaseId, ClientId, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import type { PreviewNavigationObservation, PreviewReasonCode, PreviewRenderStage } from './preview-outcome.ts';
import type { ImportLinkSignoffBinding } from '../../server/runtime/hosted/alpha-contracts.ts';
import type { PublicationEvidence } from './signoff-evidence.ts';

// Native exact-version sign-off and publication (ADR-0010). Ports only: the parent composition supplies each one from
// trusted configuration. A missing port answers 503; nothing here supplies a default, a double, an allow or a role.

/**
 * One required analysis section of a candidate, as the candidate reader found it after validation and display. `valid`
 * means its view rendered. `integrity-verified` means a registered integrity dataset (META, source-layout) passed its own
 * contract check; it is never a display claim (ADR 0012).
 */
export type RequiredSectionState = 'valid' | 'integrity-verified' | 'invalid' | 'unsupported' | 'missing';
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
  readonly requiredPreviews: readonly Readonly<{ assetId: string; state: RequiredPreviewState; reasonCode?: PreviewReasonCode; stage?: PreviewRenderStage; navigation?: PreviewNavigationObservation }>[];
}

// ---- Snapshot v2 (real-export design 2) -------------------------------------------------------------------------------
// v1 above is frozen: a candidate imported before evidence runs keeps its snapshot, its caps and its state set. A v2 snapshot
// carries no list. It names one sealed evidence run (the generation and its root) and the counts of what that run holds; the
// items themselves are paged out of the run. A later unit adds a state by adding it to the union here and one row to its table in
// `rules.ts`; the compiler refuses the build until that row exists, and v1 is never touched.

/** What an evidence item observes. The item key of every observation is `<kind>/<subject>`, so a kind is a contiguous key range. */
export type EvidenceKind = 'section' | 'preview' | 'warning' | 'error';
/**
 * v2 section states. `records-rendered` (ADR-0013, built by U6) is a required dataset shown in full by the schema-driven records
 * view; it is never `valid`, which means a native view rendered. `disagrees` (ADR-0014, Proposed; built by U12) is a META whose
 * counts disagree with its records. Until U12 gives it an acknowledgement path it holds sign-off like any other unmet state.
 */
export type SectionStateV2 = 'valid' | 'integrity-verified' | 'records-rendered' | 'disagrees' | 'invalid' | 'unsupported' | 'missing';
/** v2 preview states. A reason code beside a non-rendered state names why (`PREVIEW_REASON_CODES`); later units add states and reasons. */
export type PreviewStateV2 = 'rendered' | 'failed' | 'pending';

/** One evidence observation, as the build stored it (inside `{"input": ..., "observation": ...}`). Fixed vocabularies only. */
export type EvidenceObservation =
  | { readonly kind: 'section'; readonly key: string; readonly state: SectionStateV2 }
  | { readonly kind: 'preview'; readonly assetId: string; readonly state: PreviewStateV2; readonly reasonCode?: PreviewReasonCode; readonly stage?: PreviewRenderStage; readonly navigation?: PreviewNavigationObservation }
  | { readonly kind: 'warning'; readonly fingerprint: string }
  | { readonly kind: 'error'; readonly fingerprint: string };

/** One group of the evidence counts. `subject` is a section's key and is null for every other kind; `state` and `reason` are null where the kind has none. */
export interface EvidenceCountGroup {
  readonly kind: EvidenceKind;
  readonly subject: string | null;
  readonly state: string | null;
  readonly reason: string | null;
  readonly count: number;
}

/**
 * Facts about one candidate whose publication evidence is persisted. Like v1 there is no `ready` flag, and any other key makes it
 * unreadable (503). The counts are SQL aggregates over the sealed run, so no count depends on how many items there are.
 */
export interface CandidateSnapshotV2 {
  readonly format: 'clearcase.candidate-snapshot/2';
  readonly link: ImportLinkSignoffBinding;
  readonly preparedBy: Readonly<Pick<Principal, 'issuer' | 'subject'>>;
  /** Covers the case's warning baseline too (migration 0003), which is why no baseline list travels with a v2 snapshot. */
  readonly snapshotRevision: string;
  readonly validation: Readonly<{ verdict: 'accept' | 'report' | 'reject'; validatorVersion: string; diagnosticsSha256: string }>;
  readonly evidence: Readonly<{
    generation: string;
    /** The evidence root the run sealed under (`evidence/canonical.ts`). Sign-off binds it (U5). */
    root: string;
    /** Item rows in the run. The counts add up to exactly this. */
    items: number;
    groups: readonly EvidenceCountGroup[];
    /** Warnings whose fingerprint is not in the case's trusted baseline: exactly the set a sign-off must acknowledge. */
    newWarnings: number;
  }>;
}

/** One stored evidence row. `baseline` is whether the case's trusted baseline holds this warning's fingerprint; null for every other kind. */
export interface EvidenceItemRow { readonly key: string; readonly json: string; readonly baseline: boolean | null }
/**
 * Reads persisted evidence. It never builds, hashes or recomputes any: a page is rows the sealed run already holds, in ascending key
 * order, and the pages of one run together are exactly its rows.
 */
export interface EvidenceReader {
  /**
   * At most `limit` rows after `after` (exclusive; null starts at the first), in key order, optionally only one kind. Null when this
   * client's case has no completed run for the candidate and generation with exactly this root, or when the run's stored rows are not
   * exactly the ones its seal covers (a row added after sealing): rows outside the root are never served.
   */
  page(a: { clientId: ClientId; caseId: CaseId; candidateId: string; generation: string; root: string; after: string | null; kind: EvidenceKind | null; limit: number }): Promise<readonly EvidenceItemRow[] | null>;
}

/** Reads one private candidate of this deployment's client. Null: no such candidate. A fault rejects (503). Returns a v1 or a v2 snapshot. */
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
  /** The adapter's atomic predicates failed, including a change after its recheck callback; no mutation/receipt. */
  | { kind: 'guard-refused'; reason: 'forbidden' | 'invalid-session' | 'signoff-stale' }
  /** The pointer is not what the caller expected; nothing changed. */
  | { kind: 'conflict'; current: PublicationState }
  /** Storage refused for its own reason (unknown or unstored version, another case's version); nothing changed. */
  | { kind: 'refused'; reason: string };

/**
 * The evidence item rows a v2 publish recheck read and hashed, in key order as `[item_key, item_json]`. The commit must hold exactly
 * these rows in the sealed generation, so the transaction, not the earlier read, decides whether they are still the rows that were checked.
 */
export interface CheckedEvidenceRows { readonly signoffId: string; readonly rows: readonly (readonly [key: string, json: string])[] }

/** An operation-bound receipt, stored atomically with the pointer, never inferred from pointer equality. */
export interface PublicationApplyReceipt { readonly intent: PublicationIntent }
export interface AtomicPublicationMutation {
  readonly intent: PublicationIntent;
  /** Current retry session, deliberately NOT the original session in the persisted audit envelope. */
  readonly authority: Readonly<{ clientId: ClientId; caseId: CaseId; principal: Principal; sessionId: SessionId; capability: 'publish' }>;
  /** Fresh external-authority reads immediately before the primary D1 transaction, never saved booleans.
   * Clerk cannot participate in a D1 lock: a later external revocation can race commit. The transaction still guards
   * current D1 grants, candidate/sign-off generation, any local revocation fence, pointer and apply receipt. The recheck itself runs
   * BEFORE that transaction. A publish of a v2 sign-off returns the evidence rows it hashed, and the transaction must refuse unless the
   * sealed generation still holds exactly those rows. */
  recheck(): Promise<void | CheckedEvidenceRows>;
}
/**
 * REQUIRED parent atomic adapter, not an ordinary GRS-115 CAS wrapper. Before applying, load/compare the durable
 * operation intent, then run `recheck` immediately before the guarded primary-D1 transaction. External Clerk authority
 * is observed at that last successful check; D1 does not lock Clerk and a later external revocation can race commit.
 * Candidate/link edits, sign-off invalidation, current D1 grant state and positively observed local session denials
 * must be guarded atomically through the expected-pointer CAS AND write-once apply receipt. Those D1 writers must
 * participate; an external callback followed by an unguarded CAS is NOT this contract. A refusal writes neither
 * pointer nor receipt. Propagate recheck errors unchanged; predicate denials return `guard-refused`, not a generic
 * storage refusal. Candidate edits must durably invalidate old sign-offs even if a publication is refused.
 * Replays use the exact operation receipt, never current-pointer equality. A lost acknowledgement may reject after
 * commit, so callers must reconcile `receipt` before any fresh validation or reapplication. Receipts survive edits,
 * withdrawal, restart and later publications. No results, originals, user work or immutable evidence may be deleted.
 * If this cannot be implemented on the parent's storage/authority boundary, compose null (503), not a fallback.
 */
export interface StoragePublisher {
  readonly protocol: 'atomic-publication/1';
  receipt(a: { clientId: ClientId; caseId: CaseId; operationId: string }): Promise<PublicationApplyReceipt | null>;
  publish(a: AtomicPublicationMutation): Promise<PointerOutcome>;
  /** Results-only mutation, with the same current-authority and atomic receipt obligations. */
  withdraw(a: AtomicPublicationMutation): Promise<PointerOutcome>;
}

/**
 * Explicit case publication authority from GRS-114 grants (structurally `AuthorizeCapability` narrowed to `publish`).
 * Staff, global-admin or client identity alone never implies it. Rejects with a contract error to refuse.
 */
export type AuthorizePublication = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; capability: 'publish' }) => Promise<void>;

/**
 * One acknowledged warning and its reason. `code` is the diagnostic code of the group the publisher acknowledged it under (snapshot v2
 * only); a v1 acknowledgement has none. Warning evidence rows carry fingerprints only, so a code is recorded, not cross-checked.
 */
export interface SignoffAcknowledgement { readonly fingerprint: string; readonly reason: string; readonly code?: string }
/** The sealed evidence run a v2 sign-off binds. `candidateId` is read back from the stored row and must equal the sign-off's own. */
export interface SignoffEvidence { readonly candidateId: string; readonly generation: string; readonly root: string }
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
  /** Snapshot v2 only: the evidence root the sign-off binds. Absent on a v1 sign-off, whose identity is exactly what it always was. */
  readonly evidence?: SignoffEvidence;
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
  /** Stable envelope retained across sessions and interrupted audit settlement. */
  readonly auditEvent: AuditEvent;
  /** recorded: written, its audit event not yet confirmed; audited: effective. Only an audited sign-off can publish. */
  readonly state: 'recorded' | 'audited';
  readonly invalidatedAt: string | null;
  readonly invalidatedReason: string | null;
}

export type OperationKind = 'publish' | 'withdraw';
export type OperationState = 'pending' | 'applied' | 'refused' | 'failed' | 'audited';
export interface PublicationIntent {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly kind: OperationKind;
  readonly signoffId: string | null;
  readonly resultsVersion: ResultsVersion;
  readonly expected: PublicationState;
  readonly actor: Readonly<Pick<Principal, 'issuer' | 'subject' | 'kind'>>;
  /** Publish pins the whole immutable signed identity, not just a version or an approval flag. */
  readonly signedIdentity: SignoffIdentity | null;
  readonly auditEvent: AuditEvent;
  readonly at: string;
}
export interface OperationRecord extends PublicationIntent {
  readonly state: OperationState;
  readonly reason: string | null;
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
  /**
   * Snapshot v2 only: where sign-off and publish check the sealed evidence run (`signoff-evidence.ts`). Without it a v2 candidate
   * answers 503. The ledger must be composed with `{ evidence: true }` too, once migration 0005 is applied. (Readiness takes its own
   * `evidence` reader; this one also carries the store, so it is a separate port.)
   */
  readonly signoffEvidence?: PublicationEvidence | null;
  now(): Date;
}
