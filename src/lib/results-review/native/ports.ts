import type { AuditEvent, AuditSink, CaseId, ClientId, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import type { CandidateImportLink, FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import type { RequestBudget } from './budget.ts';
import type { StagingPorts } from './staging/ports.ts';

/** The part of a Cloudflare D1 binding this module uses. The parent passes the client's per-deployment `DB`. */
export type NativeD1Value = string | number | null;
export interface NativeD1Statement {
  bind(...values: NativeD1Value[]): NativeD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface NativeD1 { prepare(sql: string): NativeD1Statement; batch(statements: NativeD1Statement[]): Promise<unknown[]> }

/**
 * The trusted size budget of one import request. Required deployment configuration with no default: without it the routes
 * answer 503 rather than read an unbounded body. `maxPackageBytes` should not exceed what the stager's own store will take
 * (GRS-115 `maxPackageBytes`); the parent composition checks that relation when it builds the ports.
 */
export interface NativeImportBudget {
  /** Bytes of the whole JSON request. */
  readonly maxRequestBytes: number;
  /** Files of one package, manifest included. */
  readonly maxFiles: number;
  /** Bytes of one package file. */
  readonly maxFileBytes: number;
  /** Bytes of all package files. */
  readonly maxPackageBytes: number;
}

export interface OperateIntent { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }
/**
 * The separate operate capability (GRS-114's `operate`, adapted by the parent). A verified staff identity alone never
 * implies it. Resolves to allow; rejects with a contract error (`forbidden`, `unauthenticated`, `wrong-client`,
 * `identity-unavailable`) to refuse. An unknown case and a case without the capability give the same `forbidden`.
 */
export type AuthorizeOperate = (a: OperateIntent) => Promise<void>;
/**
 * The same operate check as one SQL boolean expression over this client's database (tenancy's `d1OperateObservation`).
 * Placed in a guard statement, it holds atomically with the write in that statement's D1 batch; placed in a read's
 * WHERE clause, the read returns nothing once the operator has lost the case. It never audits.
 */
export type OperateCondition = (a: OperateIntent) => SqlCondition;
export interface SqlCondition { readonly sql: string; readonly values: readonly NativeD1Value[] }
/**
 * The last checks before a release, called once everything has been hashed, parsed and read: a fresh session check, any audit
 * write that must precede the data, and the operate grant as SQL (undefined where it can only be observed, which the callback
 * has then done). The repository holds that grant and the exact verified rows in one final statement and awaits nothing after.
 */
export type ReleaseFence = (verified: readonly LinkedCandidate[]) => Promise<SqlCondition | undefined>;

/**
 * The trusted reader of finalized submissions. It must check the upload state (not only that a revision row exists), and
 * return the exact persisted manifest with the SHA-256 of its persisted bytes. `absent` covers an unknown revision and a
 * revision of another case alike; `not-final` is a reserved one. See `submissionSnapshotReader` for the D1 adapter.
 */
export interface FinalizedSubmissionReader {
  finalized(a: { clientId: ClientId; caseId: CaseId; revisionId: string }): Promise<FinalizedSubmissionSnapshot | { state: 'absent' } | { state: 'not-final' }>;
}

/** What the stager needs: the supplied package bytes and the identity those bytes claim. */
export interface StageRequest {
  clientId: ClientId; caseId: CaseId; operationId: string;
  files: ReadonlyMap<string, Uint8Array>;
  identity: { resultsVersion: ResultsVersion; manifestSha256: string };
  /** Trusted exact finalized revision for the parent's validator/original-fact selection; never package-provided. */
  submission: FinalizedSubmissionSnapshot;
}
/** One diagnostic the existing validator raised as `ORIG_CASE_MISMATCH`, copied unchanged (its subject ref and fingerprint). */
export interface CaseMismatchDiagnostic { ref: string; fingerprint: string }
export type StageOutcome =
  | {
    kind: 'staged'; repeated: boolean;
    resultsVersion: string; manifestSha256: string; inputRevisionId: string;
    verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[];
    caseMismatch: readonly CaseMismatchDiagnostic[];
  }
  | { kind: 'refused'; reason: string; detail: readonly string[] };
/**
 * The REAL validator and private stager (the case-package library's validation over trusted per-case facts, then GRS-115's
 * `ResultsStaging`). It stores a private, immutable results version and never publishes. This module neither validates a
 * package itself nor persists package bytes: it verifies the bytes and the identity the stager reports, then links.
 */
export interface CandidateStager { stage(a: StageRequest): Promise<StageOutcome> }

/** The stored package bytes of a staged version (GRS-115 `CaseReader.packageFile`), read back for a correction. */
export interface StoredPackageReader {
  files(a: { clientId: ClientId; caseId: CaseId; resultsVersion: ResultsVersion }): Promise<ReadonlyMap<string, Uint8Array> | null>;
}

export type Origin = 'import' | 'correction';
export type OperatorRef = Readonly<Pick<Principal, 'issuer' | 'subject'>>;
export interface ChangeFact { readonly path: string; readonly before: { readonly sha256: string; readonly size: number } | null; readonly after: { readonly sha256: string; readonly size: number } }
export interface CorrectionRecord { readonly reason: string; readonly operator: OperatorRef; readonly at: string; readonly changes: readonly ChangeFact[] }
/** One private candidate with its immutable link. `current` requires durable audit settlement and no supersession. */
export interface LinkedCandidate {
  readonly candidateId: string;
  readonly origin: Origin;
  readonly parentCandidateId: string | null;
  readonly current: boolean;
  readonly supersededBy: string | null;
  readonly link: CandidateImportLink;
  readonly correction: CorrectionRecord | null;
}
export type Scoped = { clientId: ClientId; caseId: CaseId };

export type AttemptClaim =
  | { kind: 'claimed' | 'repeated'; at: string }
  | { kind: 'operation-reused' };

/**
 * The durable records (namespace `native_*`, migration `0001_native_candidate_import.sql`). Every write is write-once, enforced
 * by the migration's triggers as well as the statements; a fault rejects (never reports success); a retry after an unknown
 * outcome reads back and succeeds only on the recorded row. Nothing here publishes or records a sign-off.
 */
export interface NativeCandidateRepository {
  /**
   * Records the attempt once: same actor and request digest repeats, anything else is `operation-reused`. A new attempt is
   * written only while `guard` holds; a fresh claim it stops rejects `storage-unavailable`.
   */
  claim(a: Scoped & { operationId: string; kind: Origin; operator: OperatorRef; requestSha256: string; submissionRevisionId: string; baseCandidateId: string | null; at: string; guard?: SqlCondition }): Promise<AttemptClaim>;
  byOperation(a: Scoped & { operationId: string }): Promise<LinkedCandidate | null>;
  byResultsVersion(a: Scoped & { resultsVersion: ResultsVersion }): Promise<{ candidateId: string; manifestSha256: string } | null>;
  /**
   * One atomic batch: candidate, link, success audit intent and any correction/supersession records, verified by readback.
   * A `guard` condition is checked in the same batch, so nothing is written unless it holds then. Answers the recorded
   * candidate and its committed intent.
   */
  record(a: Scoped & { operationId: string; origin: Origin; parentCandidateId: string | null; link: CandidateImportLink; correction: CorrectionRecord | null; auditEvent: AuditEvent; guard?: SqlCondition }): Promise<{ candidate: LinkedCandidate; audit: CommittedCandidateAudit }>;
  /** Committed intent only; includes the original actor/session, never exposed in candidate responses. */
  auditIntent(a: Scoped & { candidateId: string }): Promise<CommittedCandidateAudit>;
  pendingAudits(a: Scoped & { limit: number }): Promise<readonly CommittedCandidateAudit[]>;
  /**
   * Trusted caller only, AFTER the audit sink acknowledges these exact bytes. Idempotent, verified readback, which answers
   * the settled candidate. With `fence` the answer is a release: see `ReleaseFence`; when the final statement does not hold, it
   * rejects `storage-unavailable` (retryable) and releases nothing.
   */
  settleAudit(a: CommittedCandidateAudit, fence?: ReleaseFence): Promise<LinkedCandidate>;
  /** With `fence`, a found candidate is released as `settleAudit` releases; an unknown one answers null without calling it. */
  candidate(a: Scoped & { candidateId: string }, fence?: ReleaseFence): Promise<LinkedCandidate | null>;
  /** With `fence`, the whole list is released only while it is still exactly these candidates, in the case. */
  list(a: Scoped, fence?: ReleaseFence): Promise<readonly LinkedCandidate[]>;
}

/** Read access for the parent's review and sign-off components. A read through here is not audited; the caller audits. */
export interface CandidateReader {
  candidate(a: Scoped & { candidateId: string }): Promise<LinkedCandidate | null>;
  list(a: Scoped): Promise<readonly LinkedCandidate[]>;
  /** The durably audited, not superseded candidates of a case. Sign-off must require this eligibility. */
  current(a: Scoped): Promise<readonly LinkedCandidate[]>;
}

/** The exact immutable audit event committed atomically with one link, scoped to the deployment. */
export interface CommittedCandidateAudit extends Scoped { readonly candidateId: string; readonly event: AuditEvent }
/**
 * TRUSTED background-only port, not a request AuditSink. The parent must authorize delivery of committed native intents,
 * verify their source/scope, durably append the unchanged event id/actor/time/bytes, and acknowledge only exact readback.
 * Never implement by manufacturing a past verified requester (or a system actor) for requestAuditSink.
 * No adapter is supplied here: until the audit owner supplies one, pending candidates stay noncurrent.
 */
export interface CandidateAuditRecovery { appendCommitted(intent: CommittedCandidateAudit): Promise<{ eventId: string }> }

/** Everything the import needs, composed by the parent from trusted configuration. A null port answers 503. */
export interface NativeImportPorts {
  readonly clientId: ClientId;
  readonly budget: NativeImportBudget | null;
  /** The audited admission of an operator request: called once per request, before any body is read. */
  readonly authorizeOperate: AuthorizeOperate | null;
  /**
   * A fresh, unaudited observation of the same authority, for the request's later boundaries. Without it each later
   * boundary calls `authorizeOperate` again, which is stricter and audits every time.
   */
  readonly observeOperate?: AuthorizeOperate | null;
  /** The observation as SQL, so the link write and the final readback hold it atomically. Without it they observe first. */
  readonly operateCondition?: OperateCondition | null;
  /**
   * The per-request call limit of the deployment's plan. With it, an import whose package already shows more work than one
   * request may make is refused `over-budget` before its attempt is recorded, and every correction is refused so (it reads
   * back and stages a whole package). The stager checks the exact cost again before its first staging write.
   */
  readonly requestBudget?: RequestBudget | null;
  readonly submissions: FinalizedSubmissionReader | null;
  readonly stager: CandidateStager | null;
  /** Required for corrections only; null makes corrections 503 and leaves imports available. */
  readonly packages: StoredPackageReader | null;
  readonly repository: NativeCandidateRepository | null;
  /**
   * The ledger and the object store of the chunked import (migration `0002_native_import_staging.sql`). Without them the chunked
   * import is unavailable and the one-request import is unchanged.
   */
  readonly staging?: StagingPorts | null;
  readonly audit: AuditSink | null;
  now(): Date;
}
