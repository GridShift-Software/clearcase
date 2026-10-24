import type { AuditEvent, ContractError, IdentityState } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { AuditConfig } from './config.ts';

// The durable envelope of one request audit event (envelope 1). It holds exactly the fields of the existing AuditEvent
// contract: actor, action, object, exact version, outcome and time. Every string is a bounded identifier, so no case
// body, note text, secret, token or raw request can ride along; an unknown key anywhere refuses the event.

export const ENVELOPE = 1;
export type AuditErrorCode = 'invalid-event' | 'audit-unavailable' | 'audit-conflict' | 'unauthenticated' | 'forbidden' | 'identity-unavailable' | 'audit-budget' | 'invalid-query';
export type AuditError = ContractError<AuditErrorCode>;

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9.-]{0,63}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
const OUTCOMES = new Set(['succeeded', 'denied', 'failed', 'refused']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, ...want: string[]) => { const k = Object.keys(v).sort(); return k.length === want.length && want.slice().sort().every((w, i) => k[i] === w); };
const str = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const nullable = (v: unknown, re: RegExp) => v === null || str(v, re);

/** Canonical JSON: object keys sorted at every depth. Equal events give equal bytes whatever order a store returns. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks an actor's shape against the existing IdentityState. A verified actor must name a configured trusted issuer;
 * the sink validates a principal the identity provider already verified, it never authenticates or mints one.
 */
export function validActor(actor: unknown, config: AuditConfig): actor is IdentityState {
  if (!plain(actor) || !keys(actor, 'kind', 'principal', 'sessionId')) return false;
  if (actor.kind === 'anonymous') return actor.principal === null && actor.sessionId === null;
  if (actor.kind !== 'verified' || !str(actor.sessionId, SESSION)) return false;
  const p = actor.principal;
  return plain(p) && keys(p, 'issuer', 'subject', 'kind') && typeof p.issuer === 'string' && config.trustedIssuers.includes(p.issuer) && str(p.subject, SUBJECT) && (p.kind === 'client' || p.kind === 'staff');
}

/** The validated canonical envelope of one event, or invalid-event. The returned value is a fresh copy. */
export async function envelopeOf(event: unknown, config: AuditConfig): Promise<{ event: AuditEvent; canonical: string; sha256: string; bytes: number }> {
  const bad = (): AuditError => contractError('invalid-event');
  if (!plain(event) || !keys(event, 'eventId', 'actor', 'action', 'object', 'version', 'outcome', 'at')) throw bad();
  const o = event.object;
  if (!str(event.eventId, EVENT_ID) || !str(event.action, ACTION) || !validActor(event.actor, config)) throw bad();
  if (!plain(o) || !keys(o, 'kind', 'id', 'caseId') || !str(o.kind, KIND) || !str(o.id, OBJECT_ID) || !nullable(o.caseId, CASE_ID)) throw bad();
  if (!nullable(event.version, VERSION) || typeof event.outcome !== 'string' || !OUTCOMES.has(event.outcome)) throw bad();
  if (!str(event.at, ISO) || Number.isNaN(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at) throw bad();
  const copy = JSON.parse(JSON.stringify(event)) as AuditEvent;
  const text = canonical({ envelope: ENVELOPE, event: copy });
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > config.limits.maxEventBytes) throw bad();
  return { event: copy, canonical: text, sha256: await sha256Hex(text), bytes };
}

export const validEventId = (id: unknown): id is string => str(id, EVENT_ID);
export const validCaseId = (id: unknown): id is string => str(id, CASE_ID);
