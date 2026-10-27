import { LIMITS } from '../../../case-package/limits.ts';
import type { CaseId, ClientId } from '../../../server/runtime/contracts.ts';
import type { FinalizedSubmissionSnapshot } from '../../../server/runtime/hosted/alpha-contracts.ts';
import type { StageOutcome } from '../ports.ts';

/**
 * The phases of a stepped `complete`, in order. A package whose previews need no re-read skips `objects` to `readback` when its
 * results version was already stored by an earlier operation.
 *   plan         load the non-preview files, check the package, select the originals it names
 *   originals-a  read each selected original once and derive its fact (the stager's own derivation)
 *   validate-a   validate with those facts and build the exact-required-file-set coverage
 *   originals-b  derive the facts again by the storage rule, with the coverage's links
 *   begin        compare the two derivations, validate, project, reserve quota and write the version row
 *   rows         write the file rows and the read-model rows
 *   objects      copy each package file from the staged store to its content key
 *   verify       head every object against its row, then seal the version as stored
 *   readback     read the stored previews back
 *   originals-d  derive the facts a last time, after storage
 *   final        read the stored package back, validate it, and answer
 */
export const STEP_PHASES = ['plan', 'originals-a', 'validate-a', 'originals-b', 'begin', 'rows', 'objects', 'verify', 'readback', 'originals-d', 'final', 'done'] as const;
export type StepPhase = (typeof STEP_PHASES)[number];

/**
 * What one step may do. A step stops starting new units when any of these is reached; a unit in flight finishes, and a step always
 * does at least one unit. The defaults are for Workers Paid (ADR-0013): CPU is not the limit, wall time, subrequests and memory are.
 */
export interface StepBounds {
  /** Originals read and verified in one step of a pass. */
  readonly originalsPerStep: number;
  /** Bytes read in one step of a pass or a readback, and bytes copied in one step of `objects`. */
  readonly bytesPerStep: number;
  /** Package objects copied, checked or read back in one step. */
  readonly objectsPerStep: number;
  /** Read-model and file rows written in one step. */
  readonly rowsPerStep: number;
  /** Wall time after which a step starts no new unit. */
  readonly wallMsPerStep: number;
  /** How long a step holds its lease: longer than any step can run, so a live step is never taken over. */
  readonly leaseMs: number;
  /**
   * Bytes of the non-preview files held in memory together (the manifest, the datasets and the asset index). Validating one copies it
   * several times and parses it to many times its size, so this is a share of a Worker's 128 MB, not the whole of it. The poc package's
   * are 4.5 MB; a real export's have not been measured.
   */
  readonly structuredBytes: number;
  /** Steps one request runs before it answers that the import is still staging. */
  readonly stepsPerRequest: number;
  /** Wall time after which a request runs no further step. */
  readonly wallMsPerRequest: number;
}
export const DEFAULT_STEP_BOUNDS: StepBounds = Object.freeze({
  originalsPerStep: 40, bytesPerStep: 24 * 1024 * 1024, objectsPerStep: 100, rowsPerStep: 2000, wallMsPerStep: 20_000, leaseMs: 60_000,
  structuredBytes: 16 * 1024 * 1024, stepsPerRequest: 4, wallMsPerRequest: 25_000,
});

/** Non-preview files of a package: the manifest, up to 512 datasets and the asset index. Checked at open and before a step reads any. */
export const STRUCTURED_FILES = LIMITS.datasets + 2;
/** Facts a step reads back a page (one D1 query) at a time. */
export const FACT_PAGE = 500;
/** Parsed asset aliases and per-ref links, not package files. Sized above v5's 2,997 originals/attachments. */
export const STAGED_WORK_CAP = Object.freeze({ assets: 20_000, links: 20_000 });
export interface StagedWorkCounts { readonly assets: number; readonly links: number }
/** Check before any fact/original read; callers without parsed counts must budget for the ceiling. */
export function checkedWorkCounts(c: StagedWorkCounts): StagedWorkCounts {
  if (!Number.isSafeInteger(c.assets) || c.assets < 0 || c.assets > STAGED_WORK_CAP.assets
    || !Number.isSafeInteger(c.links) || c.links < 0 || c.links > STAGED_WORK_CAP.links) throw new RangeError('staged import exceeds the 20,000 asset/link row cap');
  return c;
}

/**
 * The most one step may call, by construction from the bounds and the package limits; the tests hold the measured counts to it. `d1` counts
 * D1 queries (a batch is one), `external` the identity provider's session checks, `r2` the bucket calls. Fixed: the grant and session
 * checks, the storage gate, the lease claim, the commit, the folder and the admission. Per phase, the largest of: an original costs a read, a
 * session check and a grant check; a batch of rows costs a query and a session check; `plan` and `validate-a` write at most rowsPerStep
 * asset/link facts, a batch at a time; `begin` and `final` read two passes of the capped parsed asset counts in pages, with the head and the
 * read model. R2: the structure (at most `STRUCTURED_FILES` reads, refused before the first when there are more) with a slice of originals,
 * or, per object, a read of the staged copy, a head, a put and a head after a lost race.
 */
export function stepCost(b: StepBounds, rowsPerBatch: number, counts: StagedWorkCounts = STAGED_WORK_CAP): { d1: number; external: number; r2: number } {
  checkedWorkCounts(counts);
  const per = Math.max(1, rowsPerBatch);
  const batches = Math.ceil(b.rowsPerStep / per) + 1;
  const factBatches = Math.ceil(Math.min(b.rowsPerStep, Math.max(counts.assets, counts.links)) / per) + 1;
  const factPages = 2 * (Math.ceil(counts.assets / FACT_PAGE) + 1) + 12;
  return {
    d1: 30 + factPages + Math.max(2 * b.originalsPerStep, 3 * batches, factBatches),
    external: 14 + factPages + Math.max(b.originalsPerStep, 2 * batches, factBatches),
    r2: 6 + Math.max(STRUCTURED_FILES + b.originalsPerStep, 4 * b.objectsPerStep),
  };
}

/**
 * What one `complete` request calls besides its steps: the session, sweep and acceptance reads and the manifest, the attempt claim, the
 * submission, the candidate checks, the link's second load of the structure (every non-preview file again), the link, its audit and the
 * operator checks around them.
 */
export const COMPLETE_LINK_COST = Object.freeze({ d1: 40, r2: STRUCTURED_FILES + 1, external: 16 });

/** The most one `complete` request may call: `stepsPerRequest` steps and the link. Checked against the plan's allowance before a step runs. */
export function stagedCompleteCost(b: StepBounds, rowsPerBatch: number, counts: StagedWorkCounts = STAGED_WORK_CAP): { d1: number; external: number; r2: number } {
  const c = stepCost(b, rowsPerBatch, counts), n = b.stepsPerRequest;
  return { d1: n * c.d1 + COMPLETE_LINK_COST.d1, external: n * c.external + COMPLETE_LINK_COST.external, r2: n * c.r2 + COMPLETE_LINK_COST.r2 };
}

/** The staged package a step reads: the manifest and every listed file, each verified against the manifest as it is read. */
export interface StagedPackageView {
  readonly manifest: Uint8Array;
  /** Every listed file except `manifest.json`: its size and SHA-256 from the manifest, and whether its verified bytes open with a PDF header. */
  readonly files: ReadonlyMap<string, { readonly sha256: string; readonly size: number; readonly pdf: boolean }>;
  read(path: string): Promise<Uint8Array>;
}

export interface StepRequest {
  clientId: ClientId;
  caseId: CaseId;
  operationId: string;
  identity: { resultsVersion: string; manifestSha256: string };
  /** The trusted finalized submission the link will pin; never package-provided. */
  submission: FinalizedSubmissionSnapshot;
  pkg: StagedPackageView;
}
export interface StagingStatus { kind: 'staging'; phase: StepPhase; steps: number; done: number; total: number }
export type StepOutcome = StageOutcome | StagingStatus | { kind: 'busy' };

/** One bounded step of the stager, or the answer once the run is done. Every call is safe to repeat and to run twice at once. */
export interface SteppedStager { step(a: StepRequest): Promise<StepOutcome> }
export interface SteppedPorts { readonly stager: SteppedStager; readonly bounds: StepBounds; clock(): number }
