// Real audit SQL + user-work SQL in the synthetic SQLite D1 double; no claim about a deployed Cloudflare session.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { requestAuditSink } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { authority, bind, CASE, caseReader, CLIENT, d1, database, ISSUER, LIMITS, OTHER_CASE, OTHER_CLIENT, RV1, SHA_A, type Fault } from './world.ts';

const now = () => new Date('2200-01-01T00:00:00Z');
const request = { caseId: CASE, operationId: 'atomic-note', expected: { kind: 'absent' as const }, target: { kind: 'case' as const }, body: 'Synthetic atomic note' };
async function world(maxRows = 100, fault: Fault = {}) {
  const db = database(); bind(db);
  db.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  const config = auditConfig({ clientId: CLIENT, trustedIssuers: [ISSUER], limits: { maxEventBytes: 4096, maxRows, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });
  const binding = d1(db, fault), auth = authority(); auth.grant('editor', CASE, 'editor');
  const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } });
  await provisionAuditBinding({ db: binding, config, now });
  const make = (identity = auth.identity(), audit?: C.AuditSink) => createD1UserWork({ db: binding, config: { clientId: CLIENT, limits: LIMITS }, identity,
    audit: audit ?? requestAuditSink({ db: binding, config, requester: identity.kind === 'verified' ? { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null }, now }), store: reader.reader, now });
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db, binding, auth, reader, config, make, count };
}
const written = <T>(r: C.Written<T>) => { if (r.kind !== 'written') throw new Error(r.kind); return r; };

it('16 commits note, ledger, revision, audited_at and audit once, and replays without another audit', async () => {
  const w = await world();
  try {
    const work = w.make(), first = written(await work.addNote(request));
    expect(await work.addNote(request)).toEqual(first);
    expect([w.count('uw_note'), w.count('uw_operation'), w.count('uw_case'), w.count('native_audit_events')]).toEqual([1, 1, 1, 1]);
    expect(w.db.prepare('SELECT audited_at FROM uw_operation').get()).toEqual({ audited_at: now().toISOString() });
    expect(w.db.prepare('SELECT action,version FROM native_audit_events').get()).toEqual({ action: 'user-work.note-add', version: first.version });
  } finally { w.db.close(); }
});

it('16 an audit INSERT failure rolls back a fresh note and its complete operation state', async () => {
  const w = await world();
  try {
    w.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON native_audit_events BEGIN SELECT RAISE(ABORT, 'native_audit_events synthetic failure'); END");
    await expect(w.make().addNote(request)).rejects.toMatchObject({ outcome: 'not-written' });
    expect([w.count('uw_note'), w.count('uw_operation'), w.count('uw_case'), w.count('native_audit_events')]).toEqual([0, 0, 0, 0]);
  } finally { w.db.close(); }
});

it('16 delete audit failure preserves the note and revision; a later current delete succeeds', async () => {
  const w = await world();
  try {
    const work = w.make(), first = written(await work.addNote(request));
    const remove = { caseId: CASE, id: first.value.id, expected: { kind: 'match' as const, version: first.version }, operationId: 'delete-note' };
    w.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON native_audit_events WHEN NEW.action = 'user-work.note-delete' BEGIN SELECT RAISE(ABORT, 'native_audit_events synthetic failure'); END");
    await expect(work.deleteNote(remove)).rejects.toMatchObject({ outcome: 'not-written' });
    expect([w.count('uw_note'), w.count('uw_operation'), w.count('native_audit_events')]).toEqual([1, 1, 1]);
    expect(w.db.prepare('SELECT revision FROM uw_case').get()).toEqual({ revision: first.caseRevision });
    w.db.exec('DROP TRIGGER synthetic_audit_failure');
    expect((await work.deleteNote(remove)).kind).toBe('written');
    expect(w.count('uw_note')).toBe(0);
  } finally { w.db.close(); }
});

it('16 missing hook and a hook from another D1 session fail closed before any note write', async () => {
  const w = await world();
  try {
    await expect(w.make(undefined, { append: async e => ({ eventId: e.eventId }) }).addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
    const identity = w.auth.identity();
    const otherSession = requestAuditSink({ db: d1(w.db), config: w.config, requester: { kind: 'verified', principal: identity.principal!, sessionId: identity.sessionId! }, now });
    await expect(w.make(undefined, otherSession).addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
    expect(w.count('uw_note')).toBe(0);
  } finally { w.db.close(); }
});

it('16 exhausted audit capacity refuses a fresh note without changing prior work', async () => {
  const w = await world(1);
  try {
    written(await w.make().addNote(request));
    await expect(w.make().addNote({ ...request, operationId: 'over-capacity' })).rejects.toMatchObject({ outcome: 'not-written' });
    expect([w.count('uw_note'), w.count('uw_operation'), w.count('native_audit_events')]).toEqual([1, 1, 1]);
  } finally { w.db.close(); }
});

it('16 lost batch response recovers only the committed ledger and audit; withdrawal keeps successful replay', async () => {
  const fault: Fault = { batchAfterCommit: true }, w = await world(100, fault);
  try {
    const target: C.NoteTarget = { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A } };
    const a = { ...request, target }, first = written(await w.make().addNote(a));
    w.reader.state.withdrawn.add(RV1); w.reader.state.published = null;
    expect(await w.make().addNote(a)).toEqual(first);
    expect([w.count('uw_note'), w.count('native_audit_events')]).toEqual([1, 1]);
  } finally { w.db.close(); }
});

it('16 wrong client, wrong case and revoked sessions release no note or replay result', async () => {
  const w = await world();
  try {
    await expect(w.make(w.auth.identity('editor', OTHER_CLIENT)).addNote(request)).rejects.toMatchObject({ code: 'wrong-client' });
    await expect(w.make().addNote({ ...request, caseId: OTHER_CASE })).rejects.toMatchObject({ code: 'forbidden' });
    const work = w.make(); written(await work.addNote(request)); w.auth.revoke('session-editor');
    await expect(work.addNote(request)).rejects.toMatchObject({ code: 'invalid-session' });
    expect(w.count('uw_note')).toBe(1);
  } finally { w.db.close(); }
});
