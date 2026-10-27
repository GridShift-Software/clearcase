import type { NativeD1, OperatorRef, Scoped, SqlCondition } from '../ports.ts';

export type { NativeD1 };
/** One package file the ledger has recorded as verified and stored. */
export interface StagedRow { readonly path: string; readonly sha256: string; readonly size: number; /** The verified bytes open with a PDF header. */ readonly pdf: boolean }
/** The sweep of one operation's staged objects: how far it has got. */
export interface CleanupRow { readonly reason: 'complete' | 'abandoned'; readonly afterPath: string; readonly swept: number; readonly state: 'sweeping' | 'done' }
export interface StagingSession {
  readonly operationId: string; readonly submissionRevisionId: string; readonly manifestSha256: string; readonly manifestSize: number; readonly resultsVersion: string;
  readonly expectedFiles: number; readonly expectedBytes: number; readonly requestSha256: string; readonly operator: OperatorRef; readonly openedAt: string;
}
export type OpenSession = Scoped & Omit<StagingSession, 'openedAt'> & { at: string; guard?: SqlCondition };

/**
 * The durable progress of a chunked import (migration `0002_native_import_staging.sql`). Rows are written once and kept. A write
 * that fails rejects; a retry after an unknown outcome reads back and succeeds only on what was recorded.
 */
export interface StagingLedger {
  /** Records the session once: the same operator and request digest repeats, anything else is `operation-reused`. A fresh session is written only while `guard` holds. */
  open(a: OpenSession): Promise<{ kind: 'opened' | 'repeated'; session: StagingSession } | { kind: 'operation-reused' }>;
  session(a: Scoped & { operationId: string }): Promise<StagingSession | null>;
  /** The listed paths' rows, or every row (at most `limit`) when no paths are given, in path order. */
  accepted(a: Scoped & { operationId: string; paths?: readonly string[]; limit?: number }): Promise<readonly StagedRow[]>;
  /** Records verified files in batches of the adapter's row limit, each only while the session exists and `guard` holds, then reads them back. */
  accept(a: Scoped & { operationId: string; rows: readonly StagedRow[]; at: string; guard?: SqlCondition }): Promise<void>;
  totals(a: Scoped & { operationId: string }): Promise<{ files: number; bytes: number }>;

  /** The sweep record of an operation, or null when none was started. */
  cleanup(a: Scoped & { operationId: string }): Promise<CleanupRow | null>;
  /** Records the start of a sweep once; a repeat answers the record that exists. */
  startCleanup(a: Scoped & { operationId: string; reason: CleanupRow['reason']; at: string; guard?: SqlCondition }): Promise<CleanupRow>;
  /** The operation's staged files after `afterPath`, in path order, at most `limit`. */
  after(a: Scoped & { operationId: string; afterPath: string; limit: number }): Promise<readonly StagedRow[]>;
  /** How many of the operation's staged files come after `afterPath`. */
  remainingAfter(a: Scoped & { operationId: string; afterPath: string }): Promise<number>;
  /**
   * Which of `sha256s` another live session of the case still needs (as a file or as its manifest). A session is live while it is
   * not swept, has no candidate and was opened at or after `liveFrom` or has a run that moved at or after it.
   */
  neededElsewhere(a: Scoped & { operationId: string; sha256s: readonly string[]; liveFrom: string }): Promise<ReadonlySet<string>>;
  /** Moves a sweep forward; `done` ends it. Refused for a sweep that is done or a position that goes back. */
  advanceCleanup(a: Scoped & { operationId: string; afterPath: string; swept: number; done: boolean; at: string; guard?: SqlCondition }): Promise<void>;
  /** The session of the case to sweep next: one whose sweep is under way, else the oldest opened before `before` with no sweep and no recent run. */
  nextExpired(a: Scoped & { before: string }): Promise<{ operationId: string } | null>;
}

/** The private object store of staged bytes, keyed by their SHA-256 within a case. Nothing here reads or writes a published object. */
export interface StagingStore {
  /** Writes the bytes once. Anything already under the key must be the same bytes; otherwise it rejects `integrity`. */
  put(a: Scoped & { sha256: string; bytes: Uint8Array }): Promise<'written' | 'present'>;
  /** The bytes, checked against the recorded size and SHA-256 before one is handed back. Rejects `integrity` or `storage-unavailable`. */
  read(a: Scoped & { sha256: string; size: number }): Promise<Uint8Array>;
  /** Removes the staged copy of these bytes. Only a key of this store can be removed; an absent one is not an error. */
  delete(a: Scoped & { sha256: string }): Promise<void>;
}

export interface StagingPorts {
  readonly ledger: StagingLedger; readonly store: StagingStore;
  /** The storage budget's `maxRowsPerBatch`, which sizes a batch's D1 calls. */
  readonly rowsPerBatch: number;
  /** Lowers the batch file cap below the code's own; never raises it. */
  readonly maxBatchFiles?: number;
  /** Staged objects one sweep step deletes. */
  readonly sweepObjects?: number;
  /** How long a session lives without a candidate before it may be swept. */
  readonly sessionTtlMs?: number;
}
