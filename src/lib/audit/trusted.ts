// GRS-116 trusted entry point. Import it ONLY from trusted composition (the parent's per-client service wiring and
// provisioning), never from a route, a feature module or UI code. It carries what must not reach a request:
// provisioning, the grant port with find(), and the full internal log. The parent's hosted-imports rule must restrict
// importers of this module (handoff); this file does not enforce that itself.
export { createD1AuditLog, provisionAuditBinding, type AuditLog, type AuditLookup } from './d1-log.ts';
export { trustedGrantAuditPort, type GrantAuditPort } from './facades.ts';
