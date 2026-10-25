import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { codeOf, contractError } from '../../server/runtime/errors.ts';
import type { PublicationD1 } from './ledger.ts';
import type { AtomicPublicationMutation, PointerOutcome, PublicationApplyReceipt, PublicationIntent, PublicationState, StoragePublisher } from './ports.ts';

/** The real binding, NOT a read-replica session. Each receipt/revision read starts on the primary. */
export interface PublicationD1Database {
  withSession(constraint: 'first-primary'): PublicationD1;
}
export interface D1PublicationOptions {
  readonly db: PublicationD1Database;
  /** Trusted deployment configuration, never a request field. Checked against rs_storage_identity in SQL too. */
  readonly clientId: ClientId;
  /**
   * Required fresh check of the CURRENT retry session (including expiry/revocation), not JWT verification alone.
   * The parent closes over this request's verified Identity, checks its principal/session match, then invokes
   * Identity.checkRevocation(). Called after recheck(), immediately before submitting the guarded D1 batch.
   * Known session denials return guard-refused; faults reject. No generic identity, role allow or cached verdict is supplied here.
   */
  checkSession(authority: AtomicPublicationMutation['authority']): Promise<void>;
}

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`;
}
function decode(value: unknown): PublicationApplyReceipt {
  if (typeof value !== 'string') return unavailable();
  try {
    const intent = JSON.parse(value) as PublicationIntent;
    if (!intent || typeof intent !== 'object' || typeof intent.operationId !== 'string' || !intent.auditEvent) return unavailable();
    return { intent };
  } catch { return unavailable(); }
}
const same = (a: PublicationIntent, b: PublicationIntent) => canonical(a) === canonical(b);

/**
 * SQL, not a process lock, serializes the current grant, sign-off, candidate generation, expected pointer and receipt.
 * Migration 0002_atomic_publication.sql owns those predicates and the pointer-writing receipt trigger.
 *
 * AUTHORIZATION BOUNDARY: recheck and the final external session check run BEFORE the D1 transaction, never inside an
 * imaginary D1/Clerk transaction. D1 grant revocation and locally recorded session revocation are serialized with the
 * mutation. Clerk revocation AFTER the final successful check can race the commit. The parent's literal global-lock
 * wording in atomic-publication/1 MUST be corrected before composition; see docs/acceptance/atomic-d1-publication.md.
 */
export function d1PublicationPublisher(options: D1PublicationOptions): StoragePublisher {
  const { db, clientId, checkSession } = options;
  if (!clientId || typeof db?.withSession !== 'function' || typeof checkSession !== 'function') return unavailable();

  async function receipt(a: { clientId: ClientId; caseId: CaseId; operationId: string }): Promise<PublicationApplyReceipt | null> {
    if (a.clientId !== clientId) return unavailable();
    const row = await db.withSession('first-primary').prepare(`SELECT r.intent_json FROM pub_apply_receipt r
      JOIN rs_storage_identity i ON i.singleton = 1 AND i.client_id = r.client_id AND i.layout = 'clearcase.rs/1'
      WHERE r.client_id = ? AND r.case_id = ? AND r.operation_id = ?`)
      .bind(clientId, a.caseId, a.operationId).first<{ intent_json: string }>();
    return row ? decode(row.intent_json) : null;
  }
  async function current(caseId: CaseId): Promise<PublicationState> {
    const row = await db.withSession('first-primary').prepare('SELECT state, version_id FROM rs_publication WHERE case_id = ?')
      .bind(caseId).first<{ state: 'published' | 'withdrawn'; version_id: PublicationIntent['resultsVersion'] }>();
    return row ? { kind: row.state, resultsVersion: row.version_id } : { kind: 'none' };
  }
  async function mutate(kind: 'publish' | 'withdraw', mutation: AtomicPublicationMutation): Promise<PointerOutcome> {
    // Freeze caller-owned objects before any await. A callback cannot change the committed intent/authority in place.
    const intent = structuredClone(mutation.intent), authority = structuredClone(mutation.authority);
    Object.freeze(authority.principal); Object.freeze(authority);
    if (intent.kind !== kind || intent.clientId !== clientId || authority.clientId !== clientId || authority.caseId !== intent.caseId || authority.capability !== 'publish'
      || canonical(authority.principal) !== canonical(intent.actor) || !authority.sessionId) return { kind: 'guard-refused', reason: 'forbidden' };
    const key = { clientId, caseId: intent.caseId, operationId: intent.operationId };
    const prior = await receipt(key);
    if (prior) return same(prior.intent, intent) ? { kind: 'applied', repeated: true } : { kind: 'refused', reason: 'intent-mismatch' };

    const primary = db.withSession('first-primary');
    const insert = primary.prepare(`INSERT INTO pub_apply_receipt
      (operation_id, client_id, case_id, intent_json, authority_issuer, authority_subject, authority_kind, authority_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(intent.operationId, clientId, intent.caseId, canonical(intent), authority.principal.issuer, authority.principal.subject, authority.principal.kind, authority.sessionId);
    const readback = primary.prepare('SELECT intent_json FROM pub_apply_receipt WHERE client_id = ? AND case_id = ? AND operation_id = ?')
      .bind(clientId, intent.caseId, intent.operationId);
    // Recheck errors are outside the storage catch. Preserve the controller's private Refusal object unchanged.
    await mutation.recheck();
    try {
      const checked: unknown = await checkSession(authority);
      if (checked === false) return { kind: 'guard-refused', reason: 'invalid-session' };
      if (checked !== undefined) return unavailable();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'invalid-session' || code === 'unauthenticated' || code === 'wrong-client') return { kind: 'guard-refused', reason: 'invalid-session' };
      if (code === 'forbidden' || code === 'not-found') return { kind: 'guard-refused', reason: 'forbidden' };
      throw error;
    }
    try {
      const result = await primary.batch([insert, readback]);
      const last = result[1] as { results?: { intent_json?: unknown }[] } | undefined;
      const saved = decode(last?.results?.[0]?.intent_json);
      if (!same(saved.intent, intent)) return unavailable();
      return { kind: 'applied', repeated: false };
    } catch (error) {
      // An acknowledgement may be lost AFTER commit, or another isolate may have won the same operation. Only this
      // operation's durable, exact receipt is proof. Pointer equality is never used, even for a no-op publication.
      const saved = await receipt(key);
      if (saved) return same(saved.intent, intent) ? { kind: 'applied', repeated: true } : { kind: 'refused', reason: 'intent-mismatch' };
      const message = error instanceof Error ? error.message : '';
      if (message.includes('pub:forbidden')) return { kind: 'guard-refused', reason: 'forbidden' };
      if (message.includes('pub:invalid-session')) return { kind: 'guard-refused', reason: 'invalid-session' };
      if (message.includes('pub:signoff-stale')) return { kind: 'guard-refused', reason: 'signoff-stale' };
      if (message.includes('pub:pointer-conflict')) return { kind: 'conflict', current: await current(intent.caseId) };
      if (message.includes('pub:intent-mismatch')) return { kind: 'refused', reason: 'intent-mismatch' };
      if (message.includes('pub:version-refused')) return { kind: 'refused', reason: 'version-unavailable' };
      return unavailable();
    }
  }
  return { protocol: 'atomic-publication/1', receipt, publish: (a) => mutate('publish', a), withdraw: (a) => mutate('withdraw', a) };
}

/**
 * Parent CandidateReader hook. Read this BEFORE and AFTER assembling a snapshot on the same client DB; refuse an
 * absent or changed revision, otherwise return it as snapshotRevision. The migration advances it and permanently
 * invalidates old sign-offs on every tracked dependency write, even if the dependency is subsequently restored.
 * Missing migration, an unlinked/superseded candidate or a crossed DB never yields a usable revision.
 */
export async function d1PublicationSnapshotRevision(db: PublicationD1Database, a: { clientId: ClientId; caseId: CaseId; candidateId: string }): Promise<string | null> {
  const row = await db.withSession('first-primary').prepare(`SELECT 'd1:' || g.generation AS revision FROM pub_candidate_generation g
    JOIN rs_storage_identity i ON i.singleton = 1 AND i.client_id = g.client_id AND i.layout = 'clearcase.rs/1'
    WHERE g.client_id = ? AND g.case_id = ? AND g.candidate_id = ?
      AND EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
        ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
        WHERE ai.client_id = g.client_id AND ai.case_id = g.case_id AND ai.candidate_id = g.candidate_id)
      AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession s WHERE s.client_id = g.client_id AND s.case_id = g.case_id AND s.old_candidate_id = g.candidate_id)`)
    .bind(a.clientId, a.caseId, a.candidateId).first<{ revision: string }>();
  return row?.revision ?? null;
}
