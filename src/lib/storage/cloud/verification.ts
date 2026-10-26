import type { CaseId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { OpenStorage } from './access.ts';

export interface VerificationPlan { objects: number; bytes: number }
export type VerificationAdmission = 'admitted' | 'over-budget' | 'busy';
const unavailable = (): never => { throw contractError('storage-unavailable', true); };

/**
 * Admits one verification's planned work before any R2 read. A plan over the per-call bounds is `over-budget` and reserves
 * nothing. Otherwise the plan is added to the case's current window in one atomic upsert that only writes while the window
 * stays within its bounds (`busy` when it would not), so concurrent calls cannot pass the window together. Counts only: no
 * result is remembered, and the work is spent whatever the verification finds.
 */
export async function admitVerification(s: Pick<OpenStorage, 'db' | 'budgets'>, caseId: CaseId, plan: VerificationPlan, nowMs: number): Promise<VerificationAdmission> {
  const b = s.budgets;
  if (plan.objects > b.maxVerifyObjects || plan.bytes > b.maxVerifyBytes) return 'over-budget';
  const window = Math.floor(nowMs / 1000 / b.verifyWindowSeconds) * b.verifyWindowSeconds;
  await s.db.prepare('DELETE FROM rs_verification_work WHERE case_id = ? AND window_start < ?').bind(caseId, window).run().catch(unavailable);
  const { results } = await s.db.prepare(`INSERT INTO rs_verification_work (case_id, window_start, objects, bytes) SELECT ?, ?, ?, ? WHERE ? <= ? AND ? <= ?
    ON CONFLICT (case_id, window_start) DO UPDATE SET objects = rs_verification_work.objects + excluded.objects, bytes = rs_verification_work.bytes + excluded.bytes
      WHERE rs_verification_work.objects + excluded.objects <= ? AND rs_verification_work.bytes + excluded.bytes <= ?
    RETURNING objects`)
    .bind(caseId, window, plan.objects, plan.bytes, plan.objects, b.maxVerifyObjectsPerCaseWindow, plan.bytes, b.maxVerifyBytesPerCaseWindow, b.maxVerifyObjectsPerCaseWindow, b.maxVerifyBytesPerCaseWindow)
    .all<{ objects: number }>().catch(unavailable);
  return results.length === 1 ? 'admitted' : 'busy';
}
