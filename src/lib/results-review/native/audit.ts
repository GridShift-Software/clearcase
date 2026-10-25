import { canonicalJson } from '../../case-package/canonical.ts';
import type { AuditEvent, SessionId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { sha256Text } from './digest.ts';
import type { CandidateAuditRecovery, LinkedCandidate, NativeCandidateRepository, Scoped } from './ports.ts';

/** Exact retry identity: the first committed link/session, never a later reviewer's identity. */
export async function candidateAuditEvent(c: Pick<LinkedCandidate, 'origin' | 'candidateId' | 'link'>, sessionId: SessionId): Promise<AuditEvent> {
  const l = c.link;
  return {
    eventId: `native-${c.origin}-${l.linkId}-${(await sha256Text(sessionId)).slice(0, 12)}`,
    actor: { kind: 'verified', principal: { ...l.operator }, sessionId },
    action: c.origin === 'import' ? 'results.import-candidate' : 'results.correct-candidate',
    object: { kind: 'candidate', id: c.candidateId, caseId: l.caseId },
    version: l.candidate.resultsVersion, outcome: 'succeeded', at: l.linkedAt,
  };
}

export async function verifyCandidateAudit(c: Pick<LinkedCandidate, 'origin' | 'candidateId' | 'link'>, event: AuditEvent): Promise<void> {
  if (event?.actor?.kind !== 'verified' || typeof event.actor.sessionId !== 'string' || !event.actor.sessionId) throw contractError('integrity');
  if (canonicalJson(event) !== canonicalJson(await candidateAuditEvent(c, event.actor.sessionId))) throw contractError('integrity');
}

/**
 * Parent scheduled/queue hook; independent of uploader retries and of the current request's identity.
 * One bounded page per invocation. An append/settlement interruption leaves the intent pending; replay uses exact bytes.
 * The repository and recovery adapter are trusted composition capabilities, never installed on a request route.
 */
export async function recoverNativeCandidateAudits(a: Scoped & { repository: NativeCandidateRepository; recovery: CandidateAuditRecovery; limit: number }): Promise<number> {
  if (!Number.isSafeInteger(a.limit) || a.limit < 1 || a.limit > 100) throw new TypeError('audit recovery limit must be 1..100');
  const pending = await a.repository.pendingAudits(a);
  let settled = 0;
  for (const intent of pending) {
    const ack = await a.recovery.appendCommitted(intent);
    if (ack.eventId !== intent.event.eventId) throw contractError('integrity');
    await a.repository.settleAudit(intent);
    settled++;
  }
  return settled;
}
