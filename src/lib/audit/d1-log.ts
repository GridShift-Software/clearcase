import type { AuditEvent, AuditSink, CaseId, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { contractError, isDenial } from '../server/runtime/errors.ts';
import type { AuditConfig } from './config.ts';
import { canonical, ENVELOPE, envelopeOf, sha256Hex, validActor, validCaseId, validEventId, type AuditError, type AuditErrorCode } from './event.ts';

// The native request audit log over one client's own D1 database (migrations/0001_native_audit.sql). Every statement
// names the configured client; the database must already be bound to that client by trusted provisioning.

/**
 * Who may read which audit activity. Required: a log without it cannot be built. Each method resolves only when the
 * reader holds the grant, and rejects otherwise. An unknown case and a case without a grant must reject identically.
 * Grant administration, Global Admin or staff membership alone must not satisfy caseAudit.
 */
export interface AuditReadGate {
  caseAudit(a: { principal: Principal; sessionId: SessionId; caseId: CaseId }): Promise<void>;
  administrationAudit(a: { principal: Principal; sessionId: SessionId }): Promise<void>;
}
export type AuditScope = { kind: 'case'; caseId: CaseId } | { kind: 'administration' };
export interface AuditQuery { scope: AuditScope; cursor: string | null; limit: number }
export interface AuditPage { events: AuditEvent[]; next: string | null }
/** The lookup GRS-114's GrantAuditPort needs: the event stored under an id, exactly as persisted, or null. */
export interface AuditLookup { find(eventId: string): Promise<AuditEvent | null> }
export interface AuditLog extends AuditSink, AuditLookup { query(q: AuditQuery): Promise<AuditPage> }

const error = (code: AuditErrorCode, retryable = false): AuditError => contractError(code, retryable);
const CURSOR = /^[0-9]{1,15}$/;
type Row = { seq: number; client_id: string; canonical: string; sha256: string };

/** Trusted provisioning only: binds an empty audit database to its client once. Never call it from a request path. */
export async function provisionAuditBinding(a: { db: D1; config: AuditConfig; now: () => Date }): Promise<void> {
  await a.db.prepare('INSERT INTO native_audit_binding (singleton, client_id, event_count, bound_at) VALUES (1, ?, 0, ?) ON CONFLICT(singleton) DO NOTHING').bind(a.config.clientId, a.now().toISOString()).run();
  const row = await a.db.prepare('SELECT client_id FROM native_audit_binding WHERE singleton = 1').first<{ client_id: string }>();
  if (row?.client_id !== a.config.clientId) throw new TypeError('audit database is bound to another client');
}

/**
 * One request's audit log. `requester` is the request's identity as GRS-113 established it; the log does not
 * authenticate. Appended events must carry that requester's principal (any well-formed session, so a lost-ack retry
 * from a later session still matches) or, for an anonymous requester, the anonymous actor.
 */
export function createD1AuditLog(a: { db: D1; config: AuditConfig; requester: IdentityState; gate: AuditReadGate; now: () => Date }): AuditLog {
  const { db, config, gate } = a;
  if (!gate || typeof gate.caseAudit !== 'function' || typeof gate.administrationAudit !== 'function') throw new TypeError('audit read gate is required');
  const requester = validActor(a.requester, config) ? structuredClone(a.requester) : null;
  let bound: Promise<void> | null = null, pages = 0;

  function binding() {
    bound ??= db.prepare('SELECT client_id FROM native_audit_binding WHERE singleton = 1').first<{ client_id: string }>().then(
      (row) => { if (row?.client_id !== config.clientId) throw error('audit-unavailable'); },
      () => { throw error('audit-unavailable', true); },
    );
    bound.catch(() => { bound = null; });
    return bound;
  }
  async function stored(eventId: string): Promise<Row | null> {
    await binding();
    const row = await db.prepare('SELECT seq, client_id, canonical, sha256 FROM native_audit_events WHERE client_id = ? AND event_id = ?').bind(config.clientId, eventId).first<Row>().catch(() => { throw error('audit-unavailable', true); });
    return row;
  }
  async function decode(row: Row): Promise<AuditEvent> {
    if (row.client_id !== config.clientId || (await sha256Hex(row.canonical)) !== row.sha256) throw error('audit-unavailable');
    let parsed: unknown;
    try { parsed = JSON.parse(row.canonical); } catch { throw error('audit-unavailable'); }
    const p = parsed as { envelope?: unknown; event?: unknown };
    if (p?.envelope !== ENVELOPE || canonical(parsed) !== row.canonical) throw error('audit-unavailable');
    return p.event as AuditEvent;
  }
  function sameActor(actor: IdentityState) {
    if (!requester) return false;
    if (requester.kind === 'anonymous') return actor.kind === 'anonymous';
    return actor.kind === 'verified' && canonical(actor.principal) === canonical(requester.principal);
  }
  async function write(input: unknown): Promise<{ eventId: string }> {
    const env = await envelopeOf(input, config);
    if (!sameActor(env.event.actor)) throw error('invalid-event');
    await binding();
    const e = env.event, v = e.actor;
    // Insert unless the id exists or the row budget is spent; the outcome is decided only by reading back and comparing
    // bytes, so neither a thrown insert (a lost ack) nor a silent DO NOTHING is taken as proof on its own.
    await db
      .prepare('INSERT INTO native_audit_events (event_id, client_id, envelope, action, object_kind, object_id, case_id, version, outcome, actor_kind, at, canonical, sha256) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT event_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?) < ? ON CONFLICT(event_id) DO NOTHING')
      .bind(e.eventId, config.clientId, ENVELOPE, e.action, e.object.kind, e.object.id, e.object.caseId, e.version, e.outcome, v.kind, e.at, env.canonical, env.sha256, config.clientId, config.limits.maxRows)
      .run()
      .catch(() => undefined);
    const row = await stored(e.eventId);
    if (row) {
      if (row.canonical === env.canonical && row.sha256 === env.sha256) return { eventId: e.eventId };
      throw error('audit-conflict');
    }
    const count = await db.prepare('SELECT event_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?').bind(config.clientId).first<{ event_count: number }>().catch(() => null);
    throw error('audit-unavailable', !(count && count.event_count >= config.limits.maxRows));
  }

  async function readEvent(outcome: 'succeeded' | 'denied', scope: AuditScope, allowed: boolean) {
    return write({
      eventId: `audit-read:${crypto.randomUUID()}`, actor: requester, action: 'audit.read',
      object: { kind: 'audit-log', id: scope.kind, caseId: allowed && scope.kind === 'case' ? scope.caseId : null },
      version: null, outcome, at: a.now().toISOString(),
    });
  }

  return {
    async append(event) { return write(event); },
    async find(eventId) {
      if (!validEventId(eventId)) return null;
      const row = await stored(eventId);
      return row ? decode(row) : null;
    },
    async query(q) {
      if (++pages > config.limits.maxPagesPerRequest) throw error('audit-budget');
      if (!requester || requester.kind !== 'verified') throw error('unauthenticated');
      const scope = q?.scope;
      const limit = q?.limit, cursor = q?.cursor ?? null;
      if (!Number.isInteger(limit) || limit < 1 || limit > config.limits.maxPageRows || (cursor !== null && !(typeof cursor === 'string' && CURSOR.test(cursor)))) throw error('invalid-query');
      if (!scope || (scope.kind !== 'administration' && !(scope.kind === 'case' && validCaseId(scope.caseId)))) throw error('forbidden');
      const who = { principal: requester.principal, sessionId: requester.sessionId };
      try {
        if (scope.kind === 'case') await gate.caseAudit({ ...who, caseId: scope.caseId });
        else await gate.administrationAudit(who);
      } catch (e) {
        // The refusal stands whether or not its own audit event persists; one attempt, never a retry loop.
        await readEvent('denied', scope, false).catch(() => undefined);
        throw isDenial(e) ? error('forbidden') : error('identity-unavailable', true);
      }
      // A served read is audited first: without that event, no rows.
      await readEvent('succeeded', scope, true);
      const after = cursor === null ? 0 : Number(cursor);
      const sql = scope.kind === 'case'
        ? 'SELECT seq, client_id, canonical, sha256 FROM native_audit_events WHERE client_id = ? AND case_id = ? AND seq > ? ORDER BY seq LIMIT ?'
        : "SELECT seq, client_id, canonical, sha256 FROM native_audit_events WHERE client_id = ? AND case_id IS NULL AND object_kind <> 'case' AND seq > ? ORDER BY seq LIMIT ?";
      const values = scope.kind === 'case' ? [config.clientId, scope.caseId, after, limit + 1] : [config.clientId, after, limit + 1];
      const { results } = await db.prepare(sql).bind(...values).all<Row>().catch(() => { throw error('audit-unavailable', true); });
      const page = results.slice(0, limit);
      const events = await Promise.all(page.map(decode));
      return { events, next: results.length > limit ? String(page[page.length - 1].seq) : null };
    },
  };
}
