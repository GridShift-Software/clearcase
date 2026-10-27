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
  /** Bytes of the non-preview files held in memory together (the manifest, the datasets and the asset index). */
  readonly structuredBytes: number;
  /** Steps one request runs before it answers that the import is still staging. */
  readonly stepsPerRequest: number;
  /** Wall time after which a request runs no further step. */
  readonly wallMsPerRequest: number;
}
export const DEFAULT_STEP_BOUNDS: StepBounds = Object.freeze({
  originalsPerStep: 40, bytesPerStep: 24 * 1024 * 1024, objectsPerStep: 100, rowsPerStep: 2000, wallMsPerStep: 20_000, leaseMs: 120_000,
  structuredBytes: 32 * 1024 * 1024, stepsPerRequest: 4, wallMsPerRequest: 25_000,
});

/** Non-preview files of a package: the manifest, up to 512 datasets and the asset index. */
export const STRUCTURED_FILES = 514;

/**
 * The most one step may call, as a bound the tests hold the measured counts to. `d1` counts D1 queries (a batch is one), `external` the
 * identity provider's session checks, `r2` the bucket calls. Fixed: the grant and session checks, the storage gate, the lease claim, the
 * commit, the folder and the admission. Per phase: an original costs a read, a session check and a grant check; an object costs a read
 * of the staged copy, a head, a put and a head after a lost race; a batch of rows costs a query and a session check.
 */
export function stepCost(b: StepBounds, rowsPerBatch: number): { d1: number; external: number; r2: number } {
  const batches = Math.ceil(b.rowsPerStep / Math.max(1, rowsPerBatch)) + 1;
  return {
    d1: 30 + Math.max(2 * b.originalsPerStep, 3 * batches),
    external: 14 + Math.max(b.originalsPerStep, 2 * batches),
    r2: 6 + Math.max(STRUCTURED_FILES + b.originalsPerStep, 4 * b.objectsPerStep),
  };
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
