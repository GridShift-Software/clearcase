// GRS-137 hosted client intake: one PDF per submission, or a sealed set of PDFs as one submission (U16). Parent-facing surface: ports, the D1 repository, the controller
// and the composition point. Hosted-safe: Web Crypto and the runtime contracts only, no Node built-in, no filesystem.
export type { AuthorizeUpload, IntakeBudget, IntakePorts, OriginalIntakePort, OriginalOutcome, SealStep, SetDeclaration, SetFile, SetRecord, SetState, SubmissionFile, SubmissionManifest, SubmissionRepository, UploadDeclaration, UploadRecord, UploadState } from './ports.ts';
export { createIntakeController, SEAL_STEP, type IntakeController, type IntakeRequest, type SetFileView, type SetView, type Stage, type SubmissionView } from './controller.ts';
export { fileSetDigest, FILE_SET_FORMAT, MAX_SET_FILES, type FileSetEntry } from './file-set.ts';
export { d1SubmissionRepository, revisionIdOf, type IntakeD1, type IntakeD1Statement, type IntakeD1Value } from './repository.ts';
export { intakeControllerFor, setIntakeComposition, type IntakeComposition } from './composition.ts';
export { intakeBudget } from './budget.ts';
export { safePath, type SafePath } from './path.ts';
export { finalizedSnapshotIdentity } from './snapshot-identity.ts';
