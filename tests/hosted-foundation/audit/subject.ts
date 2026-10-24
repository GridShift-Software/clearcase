// The sink under test. At the RED commit this is the base's hosted-gate d1Audit double over its own audit_event table.
import type { DatabaseSync } from 'node:sqlite';
import type { AuditSink, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { d1Audit } from '../../../src/lib/server/runtime/hosted/gate/audit.ts';

export async function subject(a: { db: DatabaseSync; d1: D1; identity: Identity }): Promise<AuditSink> {
  a.db.exec("CREATE TABLE audit_event (event_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, object_kind TEXT NOT NULL, object_id TEXT NOT NULL, case_id TEXT, version TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed', 'refused')), at TEXT NOT NULL)");
  return d1Audit({ db: a.d1, clientId: 'client-a' as never, identity: a.identity, now: () => new Date('2026-10-24T10:00:00.000Z') }).sink;
}
