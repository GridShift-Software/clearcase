import type { CaseId, ClientId, Principal, SessionId } from '../server/runtime/contracts.ts';

/**
 * The trusted size budget of one intake request. Required deployment configuration with no default: without it the
 * intake answers 503 rather than read an unbounded body. `maxFileBytes` must not exceed what the original store will
 * buffer to verify (GRS-115 `maxOriginalBytes`); the parent composition checks that relation when it builds the ports.
 */
export interface IntakeBudget {
  /** Bytes of the JSON declaration body. */
  readonly maxMetadataBytes: number;
  /** Bytes of the one PDF a submission carries. */
  readonly maxFileBytes: number;
}

/**
 * The separate client-upload capability. It is not `Identity.authorize` with a read or write-user-work operation: being
 * able to read a case or keep notes in it does not let a person supply its inputs. Resolves to allow; rejects with a
 * contract error (`forbidden`, `unauthenticated`, `wrong-client`, `identity-unavailable`) to refuse. An unknown case and
 * a case without the capability give the same `forbidden`. `clientId` is the deployment's trusted client, never a
 * request value. The parent adapts the identity service's capability check to this port.
 */
export type AuthorizeUpload = (a: { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }) => Promise<void>;

/** One storage step's outcome, structurally GRS-115's `IntakeOutcome`. */
export type OriginalOutcome = { kind: 'declared' | 'stored' | 'finalized'; repeated: boolean } | { kind: 'refused'; reason: string };
/**
 * The original store's write-once intake, structurally GRS-115's `OriginalIntake` (declare, put, finalize). The store
 * re-verifies the bytes against the declaration (canonical integrity stays with it), authorizes each step through its own
 * capability callback and reserves its quotas. Only `finalize` makes the original readable through the case originals route.
 */
export interface OriginalIntakePort {
  declare(a: { caseId: CaseId; operationId: string; assetId: string; filename: string; mediaType: string; size: number; sha256: string }): Promise<OriginalOutcome>;
  put(a: { caseId: CaseId; operationId: string; bytes: Uint8Array }): Promise<OriginalOutcome>;
  finalize(a: { caseId: CaseId; operationId: string }): Promise<OriginalOutcome>;
}

export type UploadState = 'received' | 'stored' | 'finalized';
export interface UploadDeclaration {
  clientId: ClientId; caseId: CaseId; operationId: string; assetId: string;
  path: string; filename: string; mediaType: 'application/pdf'; size: number; sha256: string;
  principal: Pick<Principal, 'issuer' | 'subject'>; at: string;
}
export interface UploadRecord extends Omit<UploadDeclaration, 'principal' | 'at'> { state: UploadState }
export interface SubmissionFile { path: string; filename: string; mediaType: string; size: number; sha256: string; assetId: string }
/** One finalized submission: an immutable input revision of the case. Its content never changes once recorded. */
export interface SubmissionManifest {
  readonly format: 'clearcase.submission-manifest/1';
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly revisionId: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly finalizedAt: string;
  readonly files: readonly SubmissionFile[];
}
export type Scoped = { clientId: ClientId; caseId: CaseId };

/**
 * The intake's own durable records (namespace `submissions_*`). Every write is idempotent on its operation id and
 * refuses a different declaration under the same id; `commitRevision` records the manifest atomically and returns the
 * stored one, so a retry after an unknown outcome recovers the same revision. A fault rejects; it never reports success.
 */
export interface SubmissionRepository {
  declare(a: UploadDeclaration): Promise<{ kind: 'declared'; repeated: boolean } | { kind: 'operation-reused' }>;
  upload(a: Scoped & { operationId: string }): Promise<UploadRecord | null>;
  /** Records that the original store acknowledged this operation's verified bytes. */
  markStored(a: Scoped & { operationId: string; at: string }): Promise<void>;
  /** Records the finalized revision for a stored (or already finalized) upload and returns the stored manifest. */
  commitRevision(a: Scoped & { operationId: string; at: string }): Promise<SubmissionManifest>;
  revision(a: Scoped & { operationId: string }): Promise<SubmissionManifest | null>;
  list(a: Scoped): Promise<readonly { upload: UploadRecord; manifest: SubmissionManifest | null }[]>;
}

/** Everything the intake needs, composed by the parent from trusted configuration. A null port answers 503. */
export interface IntakePorts {
  readonly clientId: ClientId;
  readonly budget: IntakeBudget | null;
  readonly authorizeUpload: AuthorizeUpload | null;
  readonly originals: OriginalIntakePort | null;
  readonly repository: SubmissionRepository | null;
  now(): Date;
}
