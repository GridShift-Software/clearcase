// The request budgets of the hosted app (docs/sprint/README.md, "Architecture"). A route's test passes one of these to
// `expectWithinBudget` in ./harness.ts; later tickets add `<nn>-<slug>.test.ts` beside this file and never edit it.
// A count is a round trip to the named service: D1 is a statement run outside a batch, a whole batch, or an exec; Clerk is
// every fetch to a Clerk host; R2 is get, head and list (reads only).
export interface Budget {
  /** Fetches to Clerk. */
  clerk: number;
  /** D1 round trips. */
  d1: number;
  /** R2 get, head and list calls. Left out where the budget does not constrain R2 (a mutation). */
  r2?: number;
}

/** A page view: no Clerk call, one D1 query (the grant), at most one R2 read. */
export const PAGE_VIEW: Budget = { clerk: 0, d1: 1, r2: 1 };
/** A PDF range request: the asset ticket is checked without D1, and the bytes are one R2 read. */
export const PDF_RANGE: Budget = { clerk: 0, d1: 0, r2: 1 };
/** A mutation: one D1 batch (the write and its audit row together), no Clerk call. */
export const MUTATION: Budget = { clerk: 0, d1: 1 };

/** The three counts a budget limits, in the order they are reported. */
export const COUNTED = ['clerk', 'd1', 'r2'] as const;
export type Counted = (typeof COUNTED)[number];
