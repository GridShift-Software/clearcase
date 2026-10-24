// The sink under test. At the RED commit (5a089ff5) this was the base's hosted-gate d1Audit double; it is now the
// GRS-116 native D1 audit log over its own migration, bound to the synthetic client by trusted provisioning.
import type { DatabaseSync } from 'node:sqlite';
import type { AuditSink, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { createD1AuditLog, provisionAuditBinding } from '../../../src/lib/audit/index.ts';
import { config, gate, MIGRATION, NOW } from './world.ts';

export async function subject(a: { db: DatabaseSync; d1: D1; identity: Identity }): Promise<AuditSink> {
  a.db.exec(MIGRATION);
  const cfg = config('client-a');
  await provisionAuditBinding({ db: a.d1, config: cfg, now: NOW });
  const requester = a.identity.kind === 'verified' ? { kind: 'verified' as const, principal: a.identity.principal, sessionId: a.identity.sessionId } : { kind: 'anonymous' as const, principal: null, sessionId: null };
  return createD1AuditLog({ db: a.d1, config: cfg, requester, gate: gate(), now: NOW });
}
