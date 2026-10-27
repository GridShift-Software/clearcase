import type { NativeD1, OperatorRef, Scoped, SqlCondition } from '../ports.ts';

export type { NativeD1 };
/** One package file the ledger has recorded as verified and stored. */
export interface StagedRow { readonly path: string; readonly sha256: string; readonly size: number }
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
}

/** The private object store of staged bytes, keyed by their SHA-256 within a case. Nothing here reads or writes a published object. */
export interface StagingStore {
  /** Writes the bytes once. Anything already under the key must be the same bytes; otherwise it rejects `integrity`. */
  put(a: Scoped & { sha256: string; bytes: Uint8Array }): Promise<'written' | 'present'>;
  /** The bytes, checked against the recorded size and SHA-256 before one is handed back. Rejects `integrity` or `storage-unavailable`. */
  read(a: Scoped & { sha256: string; size: number }): Promise<Uint8Array>;
}

export interface StagingPorts {
  readonly ledger: StagingLedger; readonly store: StagingStore;
  /** The storage budget's `maxRowsPerBatch`, which sizes a batch's D1 calls. */
  readonly rowsPerBatch: number;
  /** Lowers the batch file cap below the code's own; never raises it. */
  readonly maxBatchFiles?: number;
}
