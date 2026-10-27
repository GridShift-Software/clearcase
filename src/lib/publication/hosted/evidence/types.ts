/** The exact inputs a build is bound to. Every item row carries all but candidate and generation, which key it. */
export interface EvidenceBinding {
  readonly candidateId: string;
  readonly generation: string;
  readonly clientId: string;
  readonly caseId: string;
  readonly resultsVersion: string;
  readonly manifestSha256: string;
  readonly validatorVersion: string;
  readonly rendererVersion: string;
}

/** Hard per-step ceilings. The defaults are provisional, sized for Workers Free's 10 ms CPU until unit U1 measures a step. */
export interface EvidenceBounds {
  /** Observations written in one step. 1 to 500. */
  readonly itemsPerStep: number;
  /** Canonical row bytes written, and so hashed, in one step. 1 to 1 MiB. */
  readonly bytesPerStep: number;
}
export const DEFAULT_EVIDENCE_BOUNDS: EvidenceBounds = Object.freeze({ itemsPerStep: 25, bytesPerStep: 32 * 1024 });
export const MAX_ITEMS_PER_STEP = 500;
export const MAX_BYTES_PER_STEP = 1024 * 1024;

/** One observation per call. `key` must be ASCII-ordered and strictly ascending; `nextCursor` is opaque and resumes after this item. */
export type EvidenceProducerResult =
  | { readonly done: true }
  | { readonly done: false; readonly nextCursor: string; readonly key: string; readonly observation: unknown };
export type EvidenceProducer = (cursor: string | null) => Promise<EvidenceProducerResult>;

export type EvidenceRefusal = 'binding-mismatch' | 'item-too-large' | 'invalid-key' | 'key-order' | 'invalid-observation' | 'coverage';
export type EvidenceStepResult =
  | { readonly kind: 'progress'; readonly items: number }
  | { readonly kind: 'complete'; readonly root: string }
  /** Another builder holds the lease, took it while this step ran, or this builder's own lease expired before its write. Nothing was written. */
  | { readonly kind: 'leased' }
  | { readonly kind: 'refused'; readonly reason: EvidenceRefusal };

export type EvidenceClaim =
  | { readonly kind: 'claimed'; readonly cursor: string | null }
  | { readonly kind: 'complete'; readonly root: string }
  | { readonly kind: 'leased' }
  | { readonly kind: 'binding-mismatch' };
export interface EvidencePage { readonly number: number; readonly sha256: string; readonly itemCount: number }

/** What finish and the verifier need to know about a generation, read in one statement so they describe a single snapshot. */
export interface EvidenceFacts {
  readonly binding: Omit<EvidenceBinding, 'candidateId' | 'generation'>;
  readonly state: string;
  readonly root: string | null;
  readonly cursor: string | null;
  /** Item rows stored for the generation, whoever wrote them. */
  readonly itemCount: number;
  /** Greatest stored item key, or null with no rows. */
  readonly maxKey: string | null;
  readonly pages: readonly EvidencePage[];
}

/** The D1 side, as a port. Every write is conditional on the lease token, the cursor the writer read and an unexpired lease. */
export interface EvidenceStore {
  /** Create the run if absent, then take or refresh the lease if it is free, expired or already this builder's. */
  claim(binding: EvidenceBinding, leaseId: string, nowMs: number, leaseUntilMs: number): Promise<EvidenceClaim>;
  /**
   * Insert items and at most one sealed page and move the cursor, atomically. False when the lease or the cursor no longer matches, or
   * the lease is not strictly in the future of `nowMs`. A write that gives no `nowMs` is refused rather than unchecked.
   */
  commit(binding: EvidenceBinding, leaseId: string, expect: { readonly cursor: string | null }, write: {
    readonly items: readonly { readonly key: string; readonly json: string }[]; readonly page: EvidencePage | null; readonly nextCursor: string; readonly leaseUntilMs: number;
    readonly nowMs?: number }): Promise<boolean>;
  /** Page digests in page order. */
  pages(binding: EvidenceBinding): Promise<string[]>;
  /**
   * Seal the last page if any, record the root and mark the run complete, atomically and under the same condition as commit, and only
   * if the stored rows are exactly what the root covers: `items` item rows whose greatest key is `lastKey`, and pages numbered from 0
   * whose digests are `digests` (the last page included). 'uncovered' means the lease was good and the rows were not; nothing was written.
   */
  finish(binding: EvidenceBinding, leaseId: string, expect: { readonly cursor: string | null }, write: {
    readonly page: EvidencePage | null; readonly root: string; readonly nextCursor: string; readonly nowMs: number;
    readonly digests: readonly string[]; readonly items: number; readonly lastKey: string | null }): Promise<'sealed' | 'lost' | 'uncovered'>;
  /** The stored facts of a generation in one snapshot, or null when there is no run. Read-only. */
  inspect(binding: EvidenceBinding): Promise<EvidenceFacts | null>;
}
