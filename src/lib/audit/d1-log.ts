import type { AuditEvent, AuditSink, CaseId, IdentityState, Principal, SessionId, SystemAuditEvent } from '../server/runtime/contracts.ts';
import type { D1, D1Statement } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { contractError, isDenial } from '../server/runtime/errors.ts';
import type { AuditConfig } from './config.ts';
import { actorKey, canonical, ENVELOPE, envelopeOf, READ_ACTION, sha256Hex, validActor, validCaseId, validEventId, type AuditError, type AuditErrorCode, type ProducerMode, type StoredAuditEvent } from './event.ts';

// The native request audit log over one client's own D1 database (migrations/0001_native_audit.sql). Every statement
// names the configured client; the database must already be bound to that client by trusted provisioning.
//
// This file is the INTERNAL core. Its full object (append + find + query) must not reach a request route: composition
// goes through the owned facades in facades.ts (request sink, public reader) and trusted.ts (grant port, provisioning).

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
/**
 * What a reader sees of an actor. Never the session: a session id (a Clerk sid, or in the hosted gate the presented
 * login token) is not an audit subject and is dropped before any query output. `self` marks the reader's own events.
 */
export type PublicAuditActor = { kind: 'anonymous' } | { kind: 'verified'; issuer: string; subject: string; principalKind: 'client' | 'staff'; self: boolean }
  /** Automated provisioning. Not an authenticated person: no issuer, subject, principal kind or session, and never `self`. */
  | { kind: 'system'; component: 'provisioning'; operator: string };
/** One event as a query returns it, built field by field from the stored event; the stored JSON is never passed through. */
export interface PublicAuditEvent { eventId: string; actor: PublicAuditActor; action: string; object: { kind: string; id: string; caseId: CaseId | null }; version: AuditEvent['version']; outcome: AuditEvent['outcome']; at: string }
export interface PublicAuditPage { events: PublicAuditEvent[]; next: string | null }
/** The lookup GRS-114's GrantAuditPort needs: the event stored under an id, exactly as persisted, or null. */
export interface AuditLookup { find(eventId: string): Promise<StoredAuditEvent | null> }
/** The full internal log: trusted composition only. A route must receive a facade, never this object. */
export interface AuditLog extends AuditSink, AuditLookup {
  query(q: AuditQuery): Promise<PublicAuditPage>;
  atomic(a: { db: D1; event: AuditEvent }): Promise<readonly D1Statement[]>;
}
type EventClass = 'protected' | 'read' | 'denial';

const error = (code: AuditErrorCode, retryable = false): AuditError => contractError(code, retryable);
const CURSOR = /^[0-9]{1,15}$/;
type Row = { seq: number; client_id: string; canonical: string; sha256: string };

/**
 * Trusted provisioning only: binds an empty audit database to its client once. Never call it from a request path. The
 * insert is guarded by NOT EXISTS because the schema refuses a second binding row outright (no ON CONFLICT upsert).
 */
export async function provisionAuditBinding(a: { db: D1; config: AuditConfig; now: () => Date }): Promise<void> {
  await a.db.prepare('INSERT INTO native_audit_binding (singleton, client_id, bound_at) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_audit_binding)').bind(a.config.clientId, a.now().toISOString()).run().catch(() => undefined);
  const row = await a.db.prepare('SELECT client_id FROM native_audit_binding WHERE singleton = 1').first<{ client_id: string }>();
  if (row?.client_id !== a.config.clientId) throw new TypeError(row ? 'audit database is bound to another client' : 'audit database could not be bound');
}

type CoreArgs = { db: D1; config: AuditConfig; requester: IdentityState; gate: AuditReadGate | null; now: () => Date };
/** What trusted provisioning may hold: append a system event and find a stored one. Not exposed to a request. */
export interface ProvisioningLog { append(event: SystemAuditEvent): Promise<{ eventId: string }>; find(eventId: string): Promise<StoredAuditEvent | null> }
type Counters = { event_count: number; read_count: number; denial_count: number };

/**
 * One request's audit core (internal). `requester` is the request's identity as GRS-113 established it; the log does not
 * authenticate. Appended events must carry that requester's principal (any well-formed session, so a lost-ack retry
 * from a later session still matches) or, for an anonymous requester, the anonymous actor.
 *
 * Capacity is kept per class. Producers' events are 'protected' and only they count against maxRows. A served read is
 * 'read' (maxReadRows); a refused or failed read is 'denial' (maxDenialRows overall, maxDenialsPerActor each). So no
 * amount of reading, authorised or not, can use up the budget a protected action needs.
 */
export function auditCore(a: CoreArgs): AuditLog { return build(a, 'request').log; }

/**
 * The core for trusted non-request provisioning (audit/provisioning.ts only): it accepts exactly system-actor events and
 * refuses every identity actor, the opposite of a request core. No requester, no read gate, no query.
 */
export function provisioningCore(a: Omit<CoreArgs, 'requester' | 'gate'>): ProvisioningLog {
  const { log, record } = build({ ...a, requester: { kind: 'anonymous', principal: null, sessionId: null }, gate: null }, 'provisioning');
  const port: ProvisioningLog = { append: (event) => record(event), find: (eventId) => log.find(eventId) };
  return Object.freeze(port);
}

/**
 * INTERNAL committed producer, used only by recovery.ts. The mandatory loader must read immutable same-client
 * provenance, not echo its argument. No requester is constructed: a historical verified actor is evidence, not current
 * authority. Neither this constructor nor its loader is exported through a public/trusted barrel.
 */
export function committedDeliveryCore(a: Omit<CoreArgs, 'requester' | 'gate'>, load: (event: AuditEvent) => Promise<AuditEvent>): AuditSink {
  const { record } = build({ ...a, requester: null, gate: null }, 'committed');
  return Object.freeze({ async append(input: AuditEvent) {
    const requested = await envelopeOf(input, a.config);
    const proven = await envelopeOf(await load(requested.event as AuditEvent), a.config);
    if (requested.canonical !== proven.canonical || proven.event.actor.kind !== 'verified') throw error('invalid-event');
    return record(proven.event);
  } });
}

function build(a: Omit<CoreArgs, 'requester'> & { requester: IdentityState | null }, mode: ProducerMode | 'committed'): { log: AuditLog; record(input: unknown): Promise<{ eventId: string }> } {
  const { db, config, gate } = a;
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
  async function decode(row: Row): Promise<StoredAuditEvent> {
    if (row.client_id !== config.clientId || (await sha256Hex(row.canonical)) !== row.sha256) throw error('audit-unavailable');
    let parsed: unknown;
    try { parsed = JSON.parse(row.canonical); } catch { throw error('audit-unavailable'); }
    const p = parsed as { envelope?: unknown; event?: unknown };
    if (p?.envelope !== ENVELOPE || canonical(parsed) !== row.canonical) throw error('audit-unavailable');
    return p.event as StoredAuditEvent;
  }
  function sameActor(actor: StoredAuditEvent['actor']) {
    // A system producer exists only in provisioning mode, and there it is the only producer: no request can forge one.
    if (mode === 'provisioning') return actor.kind === 'system';
    if (mode === 'committed') return actor.kind === 'verified';
    if (actor.kind === 'system' || !requester) return false;
    if (requester.kind === 'anonymous') return actor.kind === 'anonymous';
    return actor.kind === 'verified' && canonical(actor.principal) === canonical(requester.principal);
  }
  /** The reader's view of an event: a fresh object with no session, built from named fields only. */
  function publicEvent(e: StoredAuditEvent): PublicAuditEvent {
    const actor: PublicAuditActor = e.actor.kind === 'system' ? { kind: 'system', component: 'provisioning', operator: e.actor.operator }
      : e.actor.kind === 'verified'
        ? { kind: 'verified', issuer: e.actor.principal.issuer, subject: e.actor.principal.subject, principalKind: e.actor.principal.kind, self: requester?.kind === 'verified' && canonical(requester.principal) === canonical(e.actor.principal) }
        : { kind: 'anonymous' };
    return { eventId: e.eventId, actor, action: e.action, object: { kind: e.object.kind, id: e.object.id, caseId: e.object.caseId }, version: e.version, outcome: e.outcome, at: e.at };
  }
  const capacity = {
    protected: { sql: '(SELECT event_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?) < ?', values: () => [config.clientId, config.limits.maxRows] },
    read: { sql: '(SELECT read_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?) < ?', values: () => [config.clientId, config.limits.maxReadRows] },
    denial: { sql: "(SELECT denial_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?) < ? AND (SELECT count(*) FROM native_audit_events WHERE client_id = ? AND class = 'denial' AND actor_key = ?) < ?", values: (key: string | null) => [config.clientId, config.limits.maxDenialRows, config.clientId, key, config.limits.maxDenialsPerActor] },
  };
  const exhausted = (cls: EventClass, c: Counters) => cls === 'protected' ? c.event_count >= config.limits.maxRows : cls === 'read' ? c.read_count >= config.limits.maxReadRows : c.denial_count >= config.limits.maxDenialRows;

  async function write(input: unknown, cls: EventClass): Promise<{ eventId: string }> {
    const env = await envelopeOf(input, config, mode === 'committed' ? 'request' : mode);
    if (!sameActor(env.event.actor)) throw error('invalid-event');
    // The read action belongs to the log itself: producers cannot write it, and the log writes nothing else under it.
    if ((env.event.action === READ_ACTION) !== (cls !== 'protected')) throw error('invalid-event');
    await binding();
    const e = env.event, v = e.actor, key = await actorKey(v);
    // Insert unless the id exists or the class's capacity is spent; the outcome is decided only by reading back and
    // comparing bytes, so neither a thrown insert (a lost ack, or a schema refusal of a racing duplicate) nor a silent
    // empty insert is taken as proof on its own.
    await db
      .prepare(`INSERT INTO native_audit_events (event_id, client_id, envelope, class, actor_key, action, object_kind, object_id, case_id, version, outcome, actor_kind, at, canonical, sha256) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_audit_events WHERE client_id = ? AND event_id = ?) AND ${capacity[cls].sql}`)
      .bind(e.eventId, config.clientId, ENVELOPE, cls, key, e.action, e.object.kind, e.object.id, e.object.caseId, e.version, e.outcome, v.kind, e.at, env.canonical, env.sha256, config.clientId, e.eventId, ...capacity[cls].values(key))
      .run()
      .catch(() => undefined);
    const row = await stored(e.eventId);
    if (row) {
      if (row.canonical === env.canonical && row.sha256 === env.sha256) return { eventId: e.eventId };
      throw error('audit-conflict');
    }
    const count = await db.prepare('SELECT event_count, read_count, denial_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?').bind(config.clientId).first<Counters>().catch(() => null);
    // A refused read that could not be stored is counted, so the bounded denial record says it is incomplete.
    if (cls === 'denial' && count) await db.prepare('UPDATE native_audit_binding SET denial_unlogged = denial_unlogged + 1 WHERE singleton = 1 AND client_id = ?').bind(config.clientId).run().catch(() => undefined);
    const spent = !!count && exhausted(cls, count);
    // A spent protected or read budget refuses every such action until the deployment raises it, and the views can only
    // call that "busy": name it in the Worker log (GRS-270). A denial past its bound is the designed outcome, not a fault.
    // The log is a diagnostic: if it throws, the refusal below still stands unchanged.
    if (spent && cls !== 'denial') {
      try { console.error('audit-capacity-exhausted', { class: cls, limit: cls === 'protected' ? config.limits.maxRows : config.limits.maxReadRows }); } catch { /* the refusal is what matters */ }
    }
    throw error('audit-unavailable', !spent);
  }

  async function readEvent(outcome: 'succeeded' | 'denied' | 'failed', scope: AuditScope, allowed: boolean) {
    return write({
      eventId: `audit-read:${crypto.randomUUID()}`, actor: requester, action: READ_ACTION,
      object: { kind: 'audit-log', id: scope.kind, caseId: allowed && scope.kind === 'case' ? scope.caseId : null },
      version: null, outcome, at: a.now().toISOString(),
    }, outcome === 'succeeded' ? 'read' : 'denial');
  }

  const log: AuditLog = {
    async append(event) { return write(event, 'protected'); },
    async atomic(input) {
      // Prepared statements must execute in the caller's exact primary session, not another database's transaction.
      if (input.db !== db || mode !== 'request') throw error('audit-unavailable');
      const env = await envelopeOf(input.event, config);
      if (!sameActor(env.event.actor) || env.event.action === READ_ACTION) throw error('invalid-event');
      const e = env.event, key = await actorKey(e.actor);
      // A failed binding, exhausted capacity or reused event id must FAIL the caller's batch, never silently insert 0.
      // The table's NOT NULL, binding and append-only triggers make the refusal transactional with the business change.
      return [db.prepare(`INSERT INTO native_audit_events
        (event_id, client_id, envelope, class, actor_key, action, object_kind, object_id, case_id, version, outcome, actor_kind, at, canonical, sha256)
        VALUES (CASE WHEN EXISTS (SELECT 1 FROM native_audit_binding WHERE singleton = 1 AND client_id = ? AND event_count < ?)
          AND NOT EXISTS (SELECT 1 FROM native_audit_events WHERE event_id = ?) THEN ? ELSE NULL END,
          ?, ?, 'protected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(config.clientId, config.limits.maxRows, e.eventId, e.eventId, config.clientId, ENVELOPE, key,
          e.action, e.object.kind, e.object.id, e.object.caseId, e.version, e.outcome, e.actor.kind, e.at, env.canonical, env.sha256)];
    },
    async find(eventId) {
      if (!validEventId(eventId)) return null;
      const row = await stored(eventId);
      return row ? decode(row) : null;
    },
    async query(q) {
      if (!gate) throw new TypeError('audit read gate is required');
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
        // A real refusal is 'denied'; a gate or backend fault is 'failed' and fails closed. The refusal stands whether or
        // not its own event persists (one attempt, never a retry loop, never an unlogged ALLOW).
        const denial = isDenial(e);
        await readEvent(denial ? 'denied' : 'failed', scope, false).catch(() => undefined);
        throw denial ? error('forbidden') : error('identity-unavailable', true);
      }
      // A served read is audited first: without that event, no rows.
      await readEvent('succeeded', scope, true);
      const after = cursor === null ? 0 : Number(cursor);
      // The administration view is events with no case id, no case-kind object and no results/work version: a producer
      // event that names a version is case activity and is never shown here. (Allowlisting administration object kinds
      // is a producer-contract follow-up.)
      const sql = scope.kind === 'case'
        ? 'SELECT seq, client_id, canonical, sha256 FROM native_audit_events WHERE client_id = ? AND case_id = ? AND seq > ? ORDER BY seq LIMIT ?'
        : "SELECT seq, client_id, canonical, sha256 FROM native_audit_events WHERE client_id = ? AND case_id IS NULL AND object_kind <> 'case' AND version IS NULL AND seq > ? ORDER BY seq LIMIT ?";
      const values = scope.kind === 'case' ? [config.clientId, scope.caseId, after, limit + 1] : [config.clientId, after, limit + 1];
      const { results } = await db.prepare(sql).bind(...values).all<Row>().catch(() => { throw error('audit-unavailable', true); });
      const page = results.slice(0, limit);
      const events = (await Promise.all(page.map(decode))).map(publicEvent);
      return { events, next: results.length > limit ? String(page[page.length - 1].seq) : null };
    },
  };
  return { log: Object.freeze(log), record: (input) => write(input, 'protected') };
}

/** The full internal log (trusted composition and tests). Needs the read gate at construction. */
export function createD1AuditLog(a: Omit<CoreArgs, 'gate'> & { gate: AuditReadGate }): AuditLog {
  const gate = a.gate;
  if (!gate || typeof gate.caseAudit !== 'function' || typeof gate.administrationAudit !== 'function') throw new TypeError('audit read gate is required');
  return auditCore(a);
}

/** A best-effort read event: one INSERT, with the database's binding trigger enforcing tenancy. No read-back or quota reads. */
export async function appendReadAudit(a: { db: D1; config: AuditConfig; requester: IdentityState; event: AuditEvent }): Promise<void> {
  if (!validActor(a.requester, a.config) || canonical(a.event.actor) !== canonical(a.requester)) throw error('invalid-event');
  // Session credentials have no place in page-read history.
  const actor: IdentityState = a.requester.kind === 'verified' ? { ...a.requester, sessionId: id('session', 'redacted') } : a.requester;
  const env = await envelopeOf({ ...a.event, actor }, a.config);
  const e = env.event;
  if (e.action === READ_ACTION) throw error('invalid-event');
  await a.db.prepare(`INSERT INTO native_audit_events
    (event_id, client_id, envelope, class, actor_key, action, object_kind, object_id, case_id, version, outcome, actor_kind, at, canonical, sha256)
    SELECT ?, ?, ?, 'protected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM native_audit_events WHERE client_id = ? AND event_id = ?)
      AND (SELECT event_count FROM native_audit_binding WHERE singleton = 1 AND client_id = ?) < ?`)
    .bind(e.eventId, a.config.clientId, ENVELOPE, await actorKey(e.actor), e.action, e.object.kind, e.object.id, e.object.caseId, e.version, e.outcome, e.actor.kind, e.at, env.canonical, env.sha256, a.config.clientId, e.eventId, a.config.clientId, a.config.limits.maxRows).run();
}

/** Collapse repeated case authorizations; preserve distinct kinds and every asset event. */
export function requestReadAudit(a: { db: D1; config: AuditConfig; waitUntil?: (work: Promise<void>) => void }) {
  const recorded = new Set<string>();
  return (event: AuditEvent): void => {
    if (event.object.kind === 'case') {
      const key = JSON.stringify([event.action, event.object.id, event.object.caseId, event.version, event.outcome]);
      if (recorded.has(key)) return;
      recorded.add(key);
    }
    const pending = new Promise<void>(resolve => setTimeout(resolve, 0))
      .then(() => appendReadAudit({ db: a.db, config: a.config, requester: event.actor, event })).catch(() => { console.warn('read-audit-unavailable'); });
    if (a.waitUntil) a.waitUntil(pending);
  };
}
