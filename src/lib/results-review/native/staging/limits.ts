import type { NativeImportBudget } from '../ports.ts';

const MiB = 1024 * 1024;
/** Files one batch request may carry. Each fresh file costs up to three R2 calls, so this bounds the request's subrequests. */
export const STAGED_BATCH_FILES = 32;
/** Raw bytes one batch request may carry, before base64. A file larger than this cannot be sent, so the manifest that lists one is refused. */
export const STAGED_BATCH_BYTES = 12 * MiB;
/** Paths a progress answer lists as still missing; ask again for the next ones. */
export const STAGED_MISSING_LISTED = 512;
/** How long a session lives without a candidate before its staged objects may be swept: seven days. */
export const STAGED_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Staged objects one sweep step deletes. */
export const STAGED_SWEEP_OBJECTS = 100;
/** JSON framing per file in a batch body: the quoted path (at most 1,024 bytes), a colon, a comma and the base64 quotes. */
const FRAMING_PER_FILE = 1100;
const ENVELOPE = 4096;

export interface StagedBounds { readonly maxBatchFiles: number; readonly maxBatchBytes: number }

/**
 * What one batch may carry, from the trusted import budget. A batch is one JSON request of base64 text, so its raw bytes are
 * three quarters of what the request limit leaves after the envelope and the per-file framing; the file cap lowers it further.
 */
export function stagedBounds(budget: Pick<NativeImportBudget, 'maxRequestBytes'>, o: { maxBatchFiles?: number } = {}): StagedBounds {
  const maxBatchFiles = Math.max(1, Math.min(o.maxBatchFiles ?? STAGED_BATCH_FILES, STAGED_BATCH_FILES));
  const room = Math.floor((budget.maxRequestBytes - ENVELOPE - maxBatchFiles * FRAMING_PER_FILE) * 3 / 4);
  return Object.freeze({ maxBatchFiles, maxBatchBytes: Math.max(0, Math.min(room, STAGED_BATCH_BYTES)) });
}

/** The client's side of the contract: the files in order, grouped greedily into batches that each fit the bounds. */
export function planBatches(entries: readonly (readonly [path: string, size: number])[], bounds: StagedBounds): string[][] {
  const batches: string[][] = [];
  let current: string[] = [], bytes = 0;
  for (const [path, size] of entries) {
    if (current.length > 0 && (current.length >= bounds.maxBatchFiles || bytes + size > bounds.maxBatchBytes)) { batches.push(current); current = []; bytes = 0; }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The most one batch of `files` may call, as a bound the tests hold the real counts to: the session, the progress and the
 * candidate reads, the row batches, the readback, and the operator checks; R2 is the manifest read and, per fresh file, a head, a
 * put and the look after a lost race. Every R2 call and each session check is a subrequest.
 */
export function stagedBatchCost(files: number, rowsPerBatch: number): { d1: number; r2: number; external: number } {
  const r2 = 1 + 3 * files;
  return { d1: 9 + Math.ceil(files / rowsPerBatch), r2, external: r2 + 6 };
}
