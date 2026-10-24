import type { AuditSink, IdentityState } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import type { AuditConfig } from './config.ts';
import { auditCore, type AuditLookup, type AuditQuery, type AuditReadGate, type PublicAuditPage } from './d1-log.ts';

// The owned facades the parent composes into a request. Each is a frozen object with exactly the methods its holder may
// use, backed by its own core: handing one to a route hands over nothing else (no find, no query on the sink, no
// provisioning). The parent passes the sink as RequestServices.audit and the reader to the audit view route only.

type Common = { db: D1; config: AuditConfig; requester: IdentityState; now: () => Date };

/** What a request route may hold: it can append an audit event and nothing else. Structurally the AuditSink contract. */
export type RequestAuditSink = Readonly<AuditSink>;
/** What an audit view route may hold: permission-scoped, paginated, read-audited queries returning session-free events. */
export type PublicAuditReader = Readonly<{ query(q: AuditQuery): Promise<PublicAuditPage> }>;
/** What GRS-114's grant service may hold (trusted composition only): append plus find of a stored event by id. */
export type GrantAuditPort = Readonly<AuditSink & AuditLookup>;

export function requestAuditSink(a: Common): RequestAuditSink {
  const core = auditCore({ ...a, gate: null });
  const sink: RequestAuditSink = { append: (event) => core.append(event) };
  return Object.freeze(sink);
}

export function publicAuditReader(a: Common & { gate: AuditReadGate }): PublicAuditReader {
  const gate = a.gate;
  if (!gate || typeof gate.caseAudit !== 'function' || typeof gate.administrationAudit !== 'function') throw new TypeError('audit read gate is required');
  const core = auditCore(a);
  const reader: PublicAuditReader = { query: (q) => core.query(q) };
  return Object.freeze(reader);
}

/** Trusted only (exported from trusted.ts, not from the public index). */
export function trustedGrantAuditPort(a: Common): GrantAuditPort {
  const core = auditCore({ ...a, gate: null });
  const port: GrantAuditPort = { append: (event) => core.append(event), find: (eventId) => core.find(eventId) };
  return Object.freeze(port);
}
