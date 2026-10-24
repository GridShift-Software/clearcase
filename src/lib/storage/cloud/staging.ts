import type { CaseId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { rejectUnavailable } from '../../server/runtime/errors.ts';
import type { StorageContext } from './context.ts';

/** The canonical projection of a validated package: local-case/project.server.ts `Projection`, structurally. */
export interface StagedProjection {
  documents: readonly { ref: string; ord: number; row_json: string; state_json: string; attachments_json: string }[];
  assets: readonly ({ key: string } & Record<string, unknown>)[];
  seeds: readonly { ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }[];
  chronologyJson: string;
  overview: string;
  expect: { documents: number; assets: number; seeds: number; files: number };
}
export interface StageInput {
  caseId: CaseId;
  operationId: string;
  files: ReadonlyMap<string, Uint8Array>;
  identity: { resultsVersion: ResultsVersion; manifestSha256: string };
  validation: { verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[] };
  projection: StagedProjection;
}
export type StageRefusal = 'over-budget' | 'integrity' | 'wrong-case' | 'unknown-case' | 'inconsistent-projection' | 'version-of-another-case' | 'conflicting-object';
export type StageOutcome = { kind: 'stored'; resultsVersion: ResultsVersion; repeated: boolean } | { kind: 'refused'; reason: StageRefusal; detail: readonly string[] };
export interface ResultsStaging { stage(a: StageInput): Promise<StageOutcome> }
export function createResultsStaging(_ctx: StorageContext): ResultsStaging {
  return { stage: rejectUnavailable('storage-unavailable') };
}
