// Native private processed-package import and immutable lineage. Parent-facing surface: ports, the D1 repository and its
// migration, the finalized-submission reader, the import service (`createNativeResultsImport`), the candidate reader, the
// controller and the composition point. Hosted-safe: Web Crypto, the case-package library's browser-safe modules and the
// runtime contracts only; no filesystem, no SQLite, no network.
export type {
  AttemptClaim, AuthorizeOperate, OperateCondition, SqlCondition, CandidateAuditRecovery, CommittedCandidateAudit, CandidateReader, CandidateStager, CaseMismatchDiagnostic, ChangeFact, CorrectionRecord, FinalizedSubmissionReader, LinkedCandidate,
  NativeCandidateRepository, NativeD1, NativeD1Statement, NativeD1Value, NativeImportBudget, NativeImportPorts, OperateIntent, OperatorRef, Origin, ReleaseFence, StageOutcome, StageRequest, StoredPackageReader,
} from './ports.ts';
export { createCandidateReader, createNativeResultsImport, type AdmittedOperator, type CorrectionRequest, type ImportOutcome, type ImportRequest, type NativeResultsImport, type RefusalCode } from './service.ts';
export { createNativeImportController, type NativeImportController, type NativeRequest } from './controller.ts';
export { nativeImportControllerFor, setNativeImportComposition, type NativeImportComposition } from './composition.ts';
export { recoverNativeCandidateAudits } from './audit.ts';
export { d1NativeCandidateRepository, linkDigest } from './repository.ts';
export { submissionSnapshotReader } from './submission-reader.ts';
export { buildCoverage, type CoverageResult, type UnlinkedCode, type UnlinkedReason } from './coverage.ts';
export { candidateIdOf, linkIdOf } from './digest.ts';
export { nativeImportBudget, nativeImportCost, overRequestBudget, type ImportShape, type RequestBudget } from './budget.ts';
/** Migration file names under src/lib/results-review/native/migrations, in apply order, for the parent's per-client schema aggregation. */
export const NATIVE_IMPORT_MIGRATIONS = ['0001_native_candidate_import.sql'] as const;
