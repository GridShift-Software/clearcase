import type { CaseId } from '../../server/runtime/contracts.ts';
import { rejectUnavailable } from '../../server/runtime/errors.ts';
import type { StorageContext } from './context.ts';

export interface DeclaredOriginal { caseId: CaseId; operationId: string; assetId: string; filename: string; mediaType: string; size: number; sha256: string }
export type IntakeRefusal = 'over-budget' | 'unknown-case' | 'not-declared' | 'operation-reused' | 'digest-mismatch' | 'conflicting-object' | 'asset-bound-to-another-original';
export type IntakeOutcome = { kind: 'declared' | 'stored' | 'finalized'; repeated: boolean } | { kind: 'refused'; reason: IntakeRefusal };
export interface OriginalIntake {
  declare(a: DeclaredOriginal): Promise<IntakeOutcome>;
  put(a: { caseId: CaseId; operationId: string; bytes: Uint8Array }): Promise<IntakeOutcome>;
  finalize(a: { caseId: CaseId; operationId: string }): Promise<IntakeOutcome>;
}
export function createOriginalIntake(_ctx: StorageContext): OriginalIntake {
  const u = rejectUnavailable('storage-unavailable');
  return { declare: u, put: u, finalize: u };
}
