// GRS-116 native request audit: the PUBLIC surface. Server-only; no route appends events except through the request sink.
// It exposes only unprivileged pieces: configuration, the request sink {append}, the public reader {query} and types.
// Provisioning, find() and the full internal log live in ./trusted.ts and are for trusted composition only.
export { auditConfig, CEILINGS, type AuditConfig, type AuditLimits } from './config.ts';
export { canonical, sha256Hex, ENVELOPE, type AuditError, type AuditErrorCode } from './event.ts';
export type { AuditQuery, AuditReadGate, AuditScope, PublicAuditActor, PublicAuditEvent, PublicAuditPage } from './d1-log.ts';
export { requestReadAudit, publicAuditReader, requestAuditSink, type PublicAuditReader, type RequestAuditSink } from './facades.ts';
/** Migration file names under src/lib/audit/migrations, in apply order, for the parent's per-client schema aggregation. */
export const AUDIT_MIGRATIONS = ['0001_native_audit.sql'] as const;
