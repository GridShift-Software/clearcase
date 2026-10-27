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

/**
 * received: declared; stored: the original store acknowledged the verified bytes; reserved: the revision and its file are
 * durably recorded (the precommit) but the submission is not final; finalized: the original is bound and the revision is final.
 */
export type UploadState = 'received' | 'stored' | 'reserved' | 'finalized';
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
 * One multi-file submission (U16). open: files are declared and stored one by one; sealing: the file-list digest is fixed and
 * the revision and its files are recorded, while the originals are finalized in steps; sealed: the revision is final.
 */
export type SetState = 'open' | 'sealing' | 'sealed';
export interface SetDeclaration { clientId: ClientId; caseId: CaseId; setId: string; fileCount: number; totalBytes: number; principal: Pick<Principal, 'issuer' | 'subject'>; at: string }
export interface SetRecord {
  clientId: ClientId; caseId: CaseId; setId: string; fileCount: number; totalBytes: number; state: SetState;
  filesSha256: string | null; openedAt: string; sealedAt: string | null;
  /** Files declared into the set; of those, the ones whose bytes the original store acknowledged; of those, the finalized ones. */
  declared: number; stored: number; finalized: number;
  /** The set's revision sequence, once recorded at the start of the seal. */
  sequence: number | null;
}
export interface SetFile { upload: UploadRecord; pathKey: string }
export type SetFileRefusal = 'operation-reused' | 'no-set' | 'set-closed' | 'set-full' | 'path-taken';

/**
 * The intake's own durable records (namespace `submissions_*`). Every write is idempotent on its operation id and
 * refuses a different declaration under the same id; `reserveRevision` records the manifest atomically and returns the
 * stored one, `commitRevision` then marks it final, so a retry after an unknown outcome recovers the same revision. A fault rejects; it never reports success.
 */
export interface SubmissionRepository {
  declare(a: UploadDeclaration): Promise<{ kind: 'declared'; repeated: boolean } | { kind: 'operation-reused' }>;
  upload(a: Scoped & { operationId: string }): Promise<UploadRecord | null>;
  /** Records that the original store acknowledged this operation's verified bytes. */
  markStored(a: Scoped & { operationId: string; at: string }): Promise<void>;
  /**
   * The precommit: durably records the revision (its case sequence) and its file facts for a stored upload, BEFORE the
   * original store makes the original visible, and returns the stored manifest. Idempotent: a retry returns the same one.
   * The upload is not final yet, so no reader shows it as a finalized submission.
   */
  reserveRevision(a: Scoped & { operationId: string; at: string }): Promise<SubmissionManifest>;
  /** Marks a reserved (or stored: it reserves first) upload final and returns the stored manifest. Idempotent. */
  commitRevision(a: Scoped & { operationId: string; at: string }): Promise<SubmissionManifest>;
  /** The revision an upload operation or a set produced; a set's revision is recorded at the start of its seal, before it is final. */
  revision(a: Scoped & { operationId: string }): Promise<SubmissionManifest | null>;
  /** Every one-file upload of the case, oldest first. A set's files are listed through the set, not here. */
  list(a: Scoped): Promise<readonly { upload: UploadRecord; manifest: SubmissionManifest | null }[]>;

  /** Opens a set under an id no upload or other set uses. Idempotent: the same declaration answers `repeated`. */
  openSet(a: SetDeclaration): Promise<{ kind: 'opened'; repeated: boolean } | { kind: 'set-reused' }>;
  set(a: Scoped & { setId: string }): Promise<SetRecord | null>;
  /** Every set of the case, oldest first. */
  sets(a: Scoped): Promise<readonly SetRecord[]>;
  /** The set an upload operation belongs to, or null for a one-file upload. */
  setOf(a: Scoped & { operationId: string }): Promise<string | null>;
  /** Declares one file of an open set: its upload and its membership in one write. Idempotent on the operation id. */
  declareSetFile(a: UploadDeclaration & { setId: string; pathKey: string }): Promise<{ kind: 'declared'; repeated: boolean } | { kind: SetFileRefusal }>;
  /** The set's files in path-key order after `after`, at most `limit`, optionally only those in one upload state. */
  setFiles(a: Scoped & { setId: string; after: string | null; limit: number; state?: UploadState }): Promise<readonly SetFile[]>;
  /**
   * The seal's precommit: fixes the digest and records the revision and every file, and marks each file reserved, in one write,
   * BEFORE any original is made visible. Idempotent: a retry returns the recorded revision.
   */
  reserveSet(a: Scoped & { setId: string; filesSha256: string; at: string }): Promise<SubmissionManifest>;
  /** Marks reserved files of a sealing set finalized once the original store has finalized their originals. Idempotent. */
  markSetFilesFinalized(a: Scoped & { setId: string; operationIds: readonly string[] }): Promise<void>;
  /** Seals a set whose files are all finalized and returns its revision. Idempotent. */
  commitSet(a: Scoped & { setId: string; at: string }): Promise<SubmissionManifest>;
}

/** Everything the intake needs, composed by the parent from trusted configuration. A null port answers 503. */
export interface IntakePorts {
  readonly clientId: ClientId;
  readonly budget: IntakeBudget | null;
  readonly authorizeUpload: AuthorizeUpload | null;
  readonly originals: OriginalIntakePort | null;
  readonly repository: SubmissionRepository | null;
  now(): Date;
  /** Bounds of one seal request; defaults to `SEAL_STEP`. Tests lower it to exercise the steps. */
  readonly sealStep?: SealStep;
  /** Files per page of a set read; defaults to 500. */
  readonly setPage?: number;
}

/**
 * The work one seal request does after the precommit: at most `files` originals finalized, stopping before `bytes` hashed
 * or `ms` elapsed (always at least one). Each finalize is about four D1 calls and one whole R2 read in the original store.
 */
export interface SealStep { readonly files: number; readonly bytes: number; readonly ms: number }
