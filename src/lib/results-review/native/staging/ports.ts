import type { NativeD1, OperatorRef, Scoped, SqlCondition } from '../ports.ts';

export type { NativeD1 };
/** One package file the ledger has recorded as verified and stored. */
export interface StagedRow { readonly path: string; readonly sha256: string; readonly size: number; /** The verified bytes open with a PDF header. */ readonly pdf: boolean }
/** The sweep of one operation's staged objects: how far its listing has got. Its existence is the tombstone the operation's writers honour. */
export interface CleanupRow { readonly reason: 'complete' | 'abandoned'; readonly afterKey: string; readonly swept: number; readonly state: 'sweeping' | 'done' }
export interface StagingSession {
  readonly operationId: string; readonly submissionRevisionId: string; readonly manifestSha256: string; readonly manifestSize: number; readonly resultsVersion: string;
  readonly expectedFiles: number; readonly expectedBytes: number; readonly requestSha256: string; readonly operator: OperatorRef; readonly openedAt: string;
}
export type OpenSession = Scoped & Omit<StagingSession, 'openedAt'> & { at: string; guard?: SqlCondition; /** Staged bytes the client's open sessions may hold together, this one included. */ maxStagedBytes: number };

/**
 * The durable progress of a chunked import (migration `0002_native_import_staging.sql`). Rows are written once and kept. A write
 * that fails rejects; a retry after an unknown outcome reads back and succeeds only on what was recorded.
 */
export interface StagingLedger {
  /**
   * Records the session once: the same operator and request digest repeats, anything else is `operation-reused`. A fresh session is written
   * only while `guard` holds and only if its bytes, with those of every session of the client not yet swept, fit `maxStagedBytes`.
   */
  open(a: OpenSession): Promise<{ kind: 'opened' | 'repeated'; session: StagingSession } | { kind: 'operation-reused' } | { kind: 'over-quota'; held: number }>;
  session(a: Scoped & { operationId: string }): Promise<StagingSession | null>;
  /** The listed paths' rows, or every row (at most `limit`) when no paths are given, in path order. */
  accepted(a: Scoped & { operationId: string; paths?: readonly string[]; limit?: number }): Promise<readonly StagedRow[]>;
  /**
   * Records verified files in batches of the adapter's row limit, each only while the session exists, has no sweep and `guard` holds, then
   * reads them back. Answers `swept` when a sweep began first and nothing more could be recorded.
   */
  accept(a: Scoped & { operationId: string; rows: readonly StagedRow[]; at: string; guard?: SqlCondition }): Promise<'accepted' | 'swept'>;
  totals(a: Scoped & { operationId: string }): Promise<{ files: number; bytes: number }>;

  /** Durable per-batch writer reservation, atomically refused once the cleanup tombstone exists. Never expires on a clock; it records when it began (`at`) for staff. */
  beginWrite(a: Scoped & { operationId: string; at: string; guard?: SqlCondition }): Promise<string | null>;
  /** Call only after every R2 put of this reservation has settled. A dead writer keeps its reservation (fail closed). */
  endWrite(a: Scoped & { operationId: string; writerId: string }): Promise<void>;
  writing(a: Scoped & { operationId: string }): Promise<boolean>;
  /**
   * Staff recovery of reservations whose settlement was never recorded: inserts the matching `writer-end` for every writer that began before
   * `startedBefore`, only while the operation's sweep is under way and its listing has not moved. Answers how many it settled. Pass a time at
   * least `WRITER_RECOVERY_GRACE_MS` ago. Not reachable over HTTP.
   */
  recoverWriters(a: Scoped & { operationId: string; startedBefore: string }): Promise<number>;

  /** The sweep record of an operation, or null when none was started. */
  cleanup(a: Scoped & { operationId: string }): Promise<CleanupRow | null>;
  /**
   * Records the start of a sweep once, and only while the operation is due: `complete` when it has a candidate, `abandoned` when it was
   * opened before `idleFrom` and nothing has been accepted or staged since. A repeat answers the record that exists; null when it is not due.
   */
  startCleanup(a: Scoped & { operationId: string; reason: CleanupRow['reason']; at: string; idleFrom: string; guard?: SqlCondition }): Promise<CleanupRow | null>;
  /** Whether the operation was opened before `idleFrom` and has had no acceptance and no stage step since. */
  idle(a: Scoped & { operationId: string; idleFrom: string }): Promise<boolean>;
  /** Moves a sweep forward from `from`, where the step read it; `done` ends it. A step that another already moved past writes nothing. */
  advanceCleanup(a: Scoped & { operationId: string; from: string; afterKey: string; swept: number; done: boolean; at: string; guard?: SqlCondition }): Promise<void>;
  /**
   * The session of the case to sweep next: one whose sweep is under way, else the oldest with a candidate and no sweep, else the oldest idle
   * since `idleFrom` with no sweep. Outstanding writers are skipped, but their capacity stays held.
   */
  nextDue(a: Scoped & { idleFrom: string }): Promise<{ operationId: string } | null>;
  /** Bytes the client's sessions hold that are not swept yet: each one's listed files and its manifest. */
  held(a: { clientId: string }): Promise<number>;
}

/** The private object store of staged bytes, keyed by operation and then SHA-256 within a case. Nothing here reads or writes a published object. */
export interface StagingStore {
  /** Writes the bytes once. Anything already under the key must be the same bytes; otherwise it rejects `integrity`. */
  put(a: Scoped & { operationId: string; sha256: string; bytes: Uint8Array }): Promise<'written' | 'present'>;
  /** The bytes, checked against the recorded size and SHA-256 before one is handed back. Rejects `not-found`, `integrity` or `storage-unavailable`. */
  read(a: Scoped & { operationId: string; sha256: string; size: number }): Promise<Uint8Array>;
  /** Removes the operation's staged copy of these bytes. Only a key of this store can be removed; an absent one is not an error. */
  delete(a: Scoped & { operationId: string; sha256: string }): Promise<void>;
  /** The names (SHA-256s) under the operation's own prefix after `after`, in order, at most `limit` (1,000 at most). Finds objects no row names. */
  list(a: Scoped & { operationId: string; after: string; limit: number }): Promise<{ names: readonly string[]; more: boolean }>;
}

export interface StagingPorts {
  readonly ledger: StagingLedger; readonly store: StagingStore;
  /** The storage budget's `maxRowsPerBatch`, which sizes a batch's D1 calls. */
  readonly rowsPerBatch: number;
  /** Lowers the batch file cap below the code's own; never raises it. */
  readonly maxBatchFiles?: number;
  /** Staged objects one sweep step deletes. */
  readonly sweepObjects?: number;
  /** How long a session lives without a candidate, and without activity, before it may be swept. */
  readonly sessionTtlMs?: number;
  /** Staged bytes the client's sessions not yet swept may hold together. */
  readonly maxStagedBytes?: number;
}
