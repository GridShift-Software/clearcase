// The immutable import result. A Candidate owns a snapshot of the exact manifest and listed
// file bytes, the identities, the parsed datasets, the asset index and the verified original
// mappings. Byte access returns defensive copies; parsed values are deep-frozen. Changes to
// the producer directory or to caller-owned buffers after import cannot change it.
import type { Diagnostic } from './codes.ts';
import type { OriginalMapping } from './originals.ts';
import type { Asset, DatasetEnvelope, Manifest } from './schema.ts';

export const VALIDATOR_VERSION = 'clearcase-case-package@0.1.0';

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export interface CandidateIdentity { resultsVersion: string; manifestSha256: string }

export interface CandidateInit {
  manifest: Manifest;
  manifestSha256: string;
  resultsVersion: string;
  inputRevisionId: string;
  files: Map<string, Uint8Array>;
  datasets: Map<string, DatasetEnvelope>;
  assets: Record<string, Asset>;
  originals: Map<string, OriginalMapping>;
  unavailable: Set<string>;
}

export class Candidate {
  readonly caseId: string;
  readonly formatVersion: number;
  readonly resultsVersion: string;
  readonly manifestSha256: string;
  readonly inputRevisionId: string;
  readonly manifest: Readonly<Manifest>;
  readonly assets: Readonly<Record<string, Asset>>;
  readonly #files: Map<string, Uint8Array>;
  readonly #datasets: Map<string, DatasetEnvelope>;
  readonly #originals: Map<string, OriginalMapping>;
  readonly #unavailable: Set<string>;

  constructor(init: CandidateInit) {
    this.manifest = deepFreeze(init.manifest);
    this.caseId = init.manifest.case.id;
    this.formatVersion = init.manifest.formatVersion;
    this.resultsVersion = init.resultsVersion;
    this.manifestSha256 = init.manifestSha256;
    this.inputRevisionId = init.inputRevisionId;
    // own copies: nothing the caller still holds can alter the candidate
    this.#files = new Map([...init.files].map(([p, b]) => [p, new Uint8Array(b)]));
    this.#datasets = new Map([...init.datasets].map(([k, e]) => [k, deepFreeze(e)]));
    this.assets = deepFreeze(Object.assign(Object.create(null), init.assets));
    this.#originals = new Map([...init.originals].map(([k, m]) => [k, deepFreeze({ ...m })]));
    this.#unavailable = new Set(init.unavailable);
    Object.freeze(this);
  }

  identity(): CandidateIdentity { return { resultsVersion: this.resultsVersion, manifestSha256: this.manifestSha256 }; }

  /** manifest.json and every listed file, sorted. */
  paths(): string[] { return [...this.#files.keys()].sort(); }

  /** A copy of one file's exact bytes, or null. */
  fileBytes(path: string): Uint8Array | null {
    const b = this.#files.get(path);
    return b ? new Uint8Array(b) : null;
  }

  /** Bounded iterator over copies of every file (what an importer persists verbatim). */
  *snapshot(): IterableIterator<{ path: string; bytes: Uint8Array }> {
    for (const p of this.paths()) yield { path: p, bytes: new Uint8Array(this.#files.get(p)!) };
  }

  datasetKeys(): string[] { return [...this.#datasets.keys()].sort(); }
  dataset(key: string): Readonly<DatasetEnvelope> | null { return this.#datasets.get(key) ?? null; }

  /** Verified original for a file asset (real on-disk path, fingerprint), or null. */
  original(ref: string): Readonly<OriginalMapping> | null { return this.#originals.get(ref) ?? null; }
  originalRefs(): string[] { return [...this.#originals.keys()].sort(); }
  /** Refs whose original is missing or refused at import (flagged, never served). */
  isUnavailable(ref: string): boolean { return this.#unavailable.has(ref); }
}

export type Verdict = 'accept' | 'report' | 'reject';

interface ResultBase {
  diagnostics: Diagnostic[];
  /** digest of the baseline-independent diagnostics; an acknowledgement binds it */
  diagnosticsSha256: string;
  validatorVersion: string;
  /** totals per code, including instances beyond the listed cap */
  counts: Record<string, number>;
  /** every warning fingerprint (uncapped, sorted) */
  warningFingerprints: string[];
  /** every error fingerprint (uncapped, sorted) */
  errorFingerprints: string[];
}

export type ImportResult =
  | (ResultBase & { verdict: 'reject'; candidate: null })
  | (ResultBase & { verdict: 'accept' | 'report'; candidate: Candidate });
