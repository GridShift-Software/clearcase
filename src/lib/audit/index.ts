// GRS-116 native request audit: the public surface for the parent's composition. Server-only; no route appends.
export { auditConfig, CEILINGS, type AuditConfig, type AuditLimits } from './config.ts';
export { canonical, sha256Hex, ENVELOPE, type AuditError, type AuditErrorCode } from './event.ts';
export { createD1AuditLog, provisionAuditBinding, type AuditLog, type AuditLookup, type AuditPage, type AuditQuery, type AuditReadGate, type AuditScope } from './d1-log.ts';
/** Migration file names under src/lib/audit/migrations, in apply order, for the parent's per-client schema aggregation. */
export const AUDIT_MIGRATIONS = ['0001_native_audit.sql'] as const;
