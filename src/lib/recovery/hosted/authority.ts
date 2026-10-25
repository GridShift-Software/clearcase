import type { CaseId, CaseOperation, ResultsVersion, WorkVersion } from '../../server/runtime/contracts.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { fail, ID } from './bytes.ts';
import type { PrivateObjectPort, RecoveryDeps } from './types.ts';

export type Outcome = 'succeeded' | 'denied' | 'failed' | 'refused';
export interface Guarded { objects: PrivateObjectPort; caseId: CaseId }

export function requireCaseId(raw: string): CaseId {
  if (!ID.test(raw)) throw fail('invalid-request');
  return raw as CaseId;
}
/** Required-null and standin refusal come first: no authority check, read or write happens against a missing or non-durable store. */
export function requireObjects(deps: Pick<RecoveryDeps, 'objects' | 'profile'>): PrivateObjectPort {
  const o = deps.objects;
  if (!o) throw fail('recovery-unavailable', true);
  if (deps.profile === 'production' && o.kind !== 'durable-private') throw fail('recovery-unavailable', true);
  return o;
}
export async function record(deps: Pick<RecoveryDeps, 'audit' | 'identity' | 'now' | 'newId'>, a: { action: string; objectKind: string; objectId: string; caseId: CaseId; outcome: Outcome; version?: ResultsVersion | WorkVersion | null }) {
  const { identity } = deps;
  const actor = identity.principal ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId! } : { kind: 'anonymous' as const, principal: null, sessionId: null };
  await deps.audit.append({ eventId: deps.newId(), actor, action: a.action, object: { kind: a.objectKind, id: a.objectId, caseId: a.caseId }, version: a.version ?? null, outcome: a.outcome, at: deps.now().toISOString() });
}
/** The completion/failure record is best effort: the required record already preceded the first byte. */
export async function recordAfter(deps: Parameters<typeof record>[0], a: Parameters<typeof record>[1]) { try { await record(deps, a); } catch { /* the outcome stands; the pre-read record exists */ } }

/**
 * Explicit authority for every scope, then the required audit record, all before any byte is read. A denial appends a scoped
 * denial (best effort) and is rethrown unchanged; an audit fault refuses the work, because an unrecorded read is not allowed.
 */
export async function authorizeAndAudit(deps: Pick<RecoveryDeps, 'audit' | 'identity' | 'now' | 'newId'>, a: { action: string; objectKind: string; objectId: string; caseId: CaseId; scopes: readonly { caseId: CaseId; operation: CaseOperation }[] }) {
  const { identity } = deps;
  try {
    if (identity.principal === null) throw fail('unauthenticated');
    await identity.checkRevocation();
    for (const s of a.scopes) await identity.authorize(s);
  } catch (e) {
    if (isDenial(e)) await recordAfter(deps, { action: a.action, objectKind: a.objectKind, objectId: a.objectId, caseId: a.caseId, outcome: 'denied' });
    throw e;
  }
  try { await record(deps, { action: a.action, objectKind: a.objectKind, objectId: a.objectId, caseId: a.caseId, outcome: 'succeeded' }); }
  catch { throw fail('audit-unavailable', true); }
}
/** Authority is rechecked after bytes are read and before anything is released or committed: a session revoked mid-run releases nothing. */
export async function recheck(deps: Pick<RecoveryDeps, 'identity'>, scopes: readonly { caseId: CaseId; operation: CaseOperation }[]) {
  await deps.identity.checkRevocation();
  for (const s of scopes) await deps.identity.authorize(s);
}
export { codeOf };
