// Synthetic per-client audit worlds over the node:sqlite D1 stand-in. Unit evidence only, not D1 evidence.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { auditConfig, type AuditReadGate } from '../../../src/lib/audit/index.ts';
import { createD1AuditLog, provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { d1, type Fault } from './d1.ts';

export const MIGRATION = readFileSync(new URL('../../../src/lib/audit/migrations/0001_native_audit.sql', import.meta.url), 'utf8');
export const ISSUER_A = 'https://clerk.client-a.example', ISSUER_STAFF = 'https://clerk.staff.example';
export const NOW = () => new Date('2026-10-24T10:00:00.000Z');
export const limits = { maxEventBytes: 2048, maxRows: 1000, maxReadRows: 1000, maxDenialRows: 100, maxDenialsPerActor: 8, maxPageRows: 50, maxPagesPerRequest: 5 };
export const config = (clientId = 'client-a', over: Partial<typeof limits> = {}) => auditConfig({ clientId, trustedIssuers: [ISSUER_A, ISSUER_STAFF], limits: { ...limits, ...over } });

export const viewer: IdentityState = { kind: 'verified', principal: { issuer: ISSUER_A, subject: 'user_a1', kind: 'client' }, sessionId: 'sess_a1' as never };
export const admin: IdentityState = { kind: 'verified', principal: { issuer: ISSUER_A, subject: 'user_admin', kind: 'client' }, sessionId: 'sess_ad' as never };
export const anonymous: IdentityState = { kind: 'anonymous', principal: null, sessionId: null };

/** Case grants by subject; administration readers by subject. Unknown and ungranted cases refuse identically. */
export function gate(a: { cases?: Record<string, string[]>; administrators?: string[] } = {}): AuditReadGate & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async caseAudit({ principal, caseId }) { calls.push(`case:${caseId}`); if (!(a.cases?.[principal.subject] ?? []).includes(caseId)) throw contractError('forbidden'); },
    async administrationAudit({ principal }) { calls.push('admin'); if (!(a.administrators ?? []).includes(principal.subject)) throw contractError('forbidden'); },
  };
}

export function world(a: { clientId?: string; bind?: boolean; fault?: Fault; over?: Partial<typeof limits> } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  const fault: Fault = { ...a.fault };
  const binding = d1(db, fault), cfg = config(a.clientId ?? 'client-a', a.over);
  const ready = a.bind === false ? Promise.resolve() : provisionAuditBinding({ db: binding, config: cfg, now: NOW });
  const log = (requester: IdentityState = viewer, g: AuditReadGate = gate()) => createD1AuditLog({ db: binding, config: cfg, requester, gate: g, now: NOW });
  const rows = () => db.prepare('SELECT event_id, case_id, action, outcome, canonical FROM native_audit_events ORDER BY seq').all() as { event_id: string; case_id: string | null; action: string; outcome: string; canonical: string }[];
  return { db, d1: binding, fault, config: cfg, ready, log, rows };
}

let n = 0;
export const event = (over: Partial<AuditEvent> = {}, actor: IdentityState = viewer): AuditEvent => ({
  eventId: `evt-${++n}`, actor: structuredClone(actor), action: 'case.read', object: { kind: 'case', id: 'case-a1', caseId: 'case-a1' as never },
  version: null, outcome: 'succeeded', at: '2026-10-24T10:00:00.000Z', ...over,
});
