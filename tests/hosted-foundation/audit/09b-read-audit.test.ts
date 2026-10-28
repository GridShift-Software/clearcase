import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { d1 } from '../provisioning/world.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { requestReadAudit, provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { AuditEvent } from '../../../src/lib/server/runtime/contracts.ts';
import { countedD1, counters } from '../budget/harness.ts';

function world(maxRows = 100) {
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
 const config = auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: ['https://issuer.example.invalid'], limits: { maxEventBytes: 4096, maxRows, maxReadRows: 100, maxDenialRows: 10, maxDenialsPerActor: 5, maxPageRows: 50, maxPagesPerRequest: 5 } });
 const c = counters(), db = countedD1(d1(sqlite), c), pending: Promise<void>[] = [];
 const event: AuditEvent = { eventId: 'synthetic-read', actor: { kind: 'verified', principal: { issuer: 'https://issuer.example.invalid', subject: 'reader', kind: 'client' }, sessionId: id('session', 'synthetic-secret-session') }, action: 'case.read', object: { kind: 'case', id: 'case-a', caseId: id('case', 'case-a') }, version: null, outcome: 'succeeded', at: '2001-01-01T00:00:00.000Z' };
 return { sqlite, db, config, c, pending, event, schedule: requestReadAudit({ db, config, waitUntil: p => pending.push(p) }) };
}
it('09b reads return before the one INSERT; repeated authorization emits one row with no session secret', async () => {
 const w = world();
 try {
  await provisionAuditBinding({ db: w.db, config: w.config, now: () => new Date(w.event.at) }); w.c.reset();
  w.schedule(w.event); w.schedule({ ...w.event, eventId: 'second-authorize' });
  // This is the response path: no database call has happened or been awaited.
  expect(w.c.d1).toBe(0);
  expect(w.sqlite.prepare('SELECT count(*) n FROM native_audit_events').get()).toEqual({ n: 0 });
  await Promise.all(w.pending);
  expect(w.c.d1).toBe(1);
  const rows = w.sqlite.prepare('SELECT canonical FROM native_audit_events').all();
  expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain('synthetic-secret-session');
 } finally { w.sqlite.close(); }
});
it('09b a failed background INSERT never fails the read', async () => {
 const w = world();
 try {
  w.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON native_audit_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  expect(() => w.schedule(w.event)).not.toThrow();
  await expect(Promise.all(w.pending)).resolves.toEqual([undefined]);
  expect(w.c.d1).toBe(1);
 } finally { w.sqlite.close(); }
});

it('M1: ten page reads respect maxRows=3 without foreground queries or failed reads', async () => {
 const w = world(3);
 try {
  await provisionAuditBinding({ db: w.db, config: w.config, now: () => new Date(w.event.at) }); w.c.reset();
  for (let i = 0; i < 10; i++) {
   const schedule = requestReadAudit({ db: w.db, config: w.config, waitUntil: p => w.pending.push(p) });
   expect(() => schedule({ ...w.event, eventId: `capacity-read-${i}`, outcome: i % 2 ? 'denied' : 'succeeded' })).not.toThrow();
  }
  expect(w.c.d1).toBe(0);
  await expect(Promise.all(w.pending)).resolves.toHaveLength(10);
  expect(w.sqlite.prepare('SELECT count(*) n FROM native_audit_events').get()).toEqual({ n: 3 });
  expect(w.c.d1).toBe(10);
 } finally { w.sqlite.close(); }
});
it('L1: a failed deferred insert logs one code-only diagnostic', async () => {
 const w = world(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
 try {
  await provisionAuditBinding({ db: w.db, config: w.config, now: () => new Date(w.event.at) });
  w.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON native_audit_events BEGIN SELECT RAISE(ABORT, 'synthetic-secret-session'); END;");
  w.schedule(w.event);
  await Promise.all(w.pending);
  expect(warn).toHaveBeenCalledExactlyOnceWith('read-audit-unavailable');
 } finally { warn.mockRestore(); w.sqlite.close(); }
});

it('M2: authorization dedupe never discards a different kind or an asset-level event', async () => {
 const w = world();
 try {
  await provisionAuditBinding({ db: w.db, config: w.config, now: () => new Date(w.event.at) });
  w.schedule(w.event); w.schedule({ ...w.event, eventId: 'repeat-auth' });
  w.schedule({ ...w.event, eventId: 'original-auth', action: 'case.read-original' });
  w.schedule({ ...w.event, eventId: 'asset-delivery', action: 'asset.read-original', object: { kind: 'asset', id: 'synthetic-original', caseId: w.event.object.caseId } });
  await Promise.all(w.pending);
  expect(w.sqlite.prepare('SELECT action, object_id FROM native_audit_events ORDER BY seq').all()).toEqual([
   { action: 'case.read', object_id: 'case-a' }, { action: 'case.read-original', object_id: 'case-a' }, { action: 'asset.read-original', object_id: 'synthetic-original' },
  ]);
 } finally { w.sqlite.close(); }
});
