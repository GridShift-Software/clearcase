// Node entry point of the results-package library. Storage-agnostic: it writes nothing except
// through writePackageDir to an explicit output directory. Browser rendering code lives in
// ./browser.ts, which imports no filesystem code and no Node built-ins.
export { importCandidate, type ImportOptions } from './import.ts';
export { Candidate, VALIDATOR_VERSION, type CandidateIdentity, type ImportResult, type Verdict } from './candidate.ts';
export { verifyCandidateBytes, type BytesVerdict, type StoredFiles } from './verify-bytes.ts';
export { readCandidate, type CandidateReader, type DocumentState, type AttachmentRoute, type AttachmentView, type DerivedCounts } from './reader.ts';
export { canActivate, acknowledge, acceptedWarnings, newWarningFingerprints, type ActivationDecision, type ActivationReason } from './policy.ts';
export { inputRevisionId, resultsVersionOf, sha256Hex } from './hash.ts';
export { buildPackage, writePackageDir, type PackageSpec, type DatasetSpec } from './writer.ts';
export { convertV5, ADAPTER, type ConvertOptions, type ConvertResult } from './v5/adapter.ts';
export { reassembleV5 } from './v5/reassemble.ts';
export type { PackageSource } from './source.ts';
export type { OriginalMapping, Progress } from './originals.ts';
export type { Acknowledgement, Manifest, DatasetEnvelope, Asset, AssetIndex } from './schema.ts';
export { LIMITS, type Limits } from './limits.ts';
export * from './browser.ts';
