import type { AuditEvent, AuditSink, SystemAuditEvent } from '../server/runtime/contracts.ts';

// The audit port grant management needs. The global AuditSink stays append-only and unchanged; a repeated eventId is
// refused by its primary key. A plain sink therefore cannot tell a lost acknowledgement (the event persisted) from a
// failed append (it did not), so management refuses to start without a lookup by event id. The parent's D1 adapter
// (GRS-116) must provide `find` over the same table, and that table must keep event_id unique: the exactly-once
// guarantee rests on that uniqueness plus this lookup.

/** An event the log may hold: a request event, or a system event only trusted provisioning wrote. */
export type AnyAuditEvent = AuditEvent | SystemAuditEvent;
/** Reads back the event stored under an id, exactly as persisted; null when none is. Rejects when the log is unavailable. */
export interface AuditLookup { find(eventId: string): Promise<AnyAuditEvent | null> }
/** What grant management holds: the request-typed sink plus find. It can append request events only (never a system actor). */
export type GrantAuditPort = AuditSink & AuditLookup;
/** What the provisioning bootstrap holds (provisioning.ts only): append a SYSTEM event plus find. Never a request identity. */
export type ProvisioningAuditPort = { append(event: SystemAuditEvent): Promise<{ eventId: string }> } & AuditLookup;

/** Canonical JSON: object keys sorted at every depth, so equal events compare equal whatever order a store returns. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
