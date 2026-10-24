// GRS-116 native D1 audit log: append idempotence and durability, find, binding, budgets and permission-scoped reads.
// node:sqlite stand-in only; these are unit results, not D1, workerd or provider evidence.
import { describe, expect, it } from 'vitest';
import { auditConfig, createD1AuditLog, provisionAuditBinding } from '../../../src/lib/audit/index.ts';
import { admin, anonymous, config, event, gate, ISSUER_A, NOW, viewer, world } from './world.ts';

describe('append and find', () => {
  it('acknowledges a lost-ack retry only after reading back identical bytes, and find returns the stored event', async () => {
    const w = world(); await w.ready; w.fault.failInsertAfterCommit = true;
    const e = event();
    await expect(w.log().append(e)).resolves.toEqual({ eventId: e.eventId });
    w.fault.failInsertAfterCommit = false;
    await expect(w.log().append(structuredClone(e))).resolves.toEqual({ eventId: e.eventId });
    expect(w.rows()).toHaveLength(1);
    await expect(w.log().find(e.eventId)).resolves.toEqual(e);
    await expect(w.log().find('evt-absent')).resolves.toBeNull();
    await expect(w.log().find('not an id')).resolves.toBeNull();
  });
  it('refuses the same id with a different event (even a different session) as audit-conflict and keeps the first', async () => {
    const w = world(); await w.ready;
    const e = event();
    await w.log().append(e);
    await expect(w.log().append({ ...e, outcome: 'denied' })).rejects.toMatchObject({ code: 'audit-conflict' });
    await expect(w.log().append({ ...e, actor: { ...viewer, sessionId: 'sess_other' as never } })).rejects.toMatchObject({ code: 'audit-conflict' });
    expect(w.rows().map((r) => r.outcome)).toEqual(['succeeded']);
  });
  it('refuses with audit-unavailable when storage fails or the insert does not persist, never a fake ack', async () => {
    const down = world(); await down.ready; down.fault.failAll = true;
    await expect(down.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
    await expect(down.log().find('evt-1')).rejects.toMatchObject({ code: 'audit-unavailable' });
    const full = world(); await full.ready; full.fault.failInsert = true;
    await expect(full.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect(full.rows()).toEqual([]);
  });
  it('refuses at the row budget (not retryable) while an identical replay of a stored event still acknowledges', async () => {
    const w = world({ over: { maxRows: 2 } }); await w.ready;
    const first = event();
    await w.log().append(first); await w.log().append(event());
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    await expect(w.log().append(first)).resolves.toEqual({ eventId: first.eventId });
    expect(w.rows()).toHaveLength(2);
  });
  it('detects a stored row whose bytes no longer match their digest', async () => {
    const w = world(); await w.ready;
    const e = event(); await w.log().append(e);
    w.db.exec('DROP TRIGGER native_audit_events_no_update');
    w.db.prepare("UPDATE native_audit_events SET canonical = replace(canonical, 'succeeded', 'failed')").run();
    await expect(w.log().find(e.eventId)).rejects.toMatchObject({ code: 'audit-unavailable' });
  });
  it('keeps history append-only in the schema', async () => {
    const w = world(); await w.ready; await w.log().append(event());
    expect(() => w.db.exec("UPDATE native_audit_events SET outcome = 'failed'")).toThrow(/append-only/);
    expect(() => w.db.exec('DELETE FROM native_audit_events')).toThrow(/append-only/);
    expect(() => w.db.exec("UPDATE native_audit_binding SET client_id = 'client-b'")).toThrow(/fixed/);
  });
});

describe('event shape and actor', () => {
  it('refuses unknown keys, case text, oversize events and malformed values as invalid-event', async () => {
    const w = world({ over: { maxEventBytes: 600 } }); await w.ready;
    const log = w.log();
    for (const bad of [
      { ...event(), body: 'case note text' },
      { ...event(), object: { kind: 'note', id: 'n-1', caseId: null, text: 'secret' } },
      event({ object: { kind: 'note', id: 'contains spaces and text', caseId: null } }),
      event({ eventId: 'x'.repeat(129) }),
      event({ at: '2026-10-24T10:00:00Z' }),
      event({ outcome: 'ok' as never }),
      event({ object: { kind: 'case', id: 'a'.repeat(128), caseId: 'b'.repeat(128) as never }, version: 'c'.repeat(128) as never, action: 'd'.repeat(64) }),
    ]) await expect(log.append(bad as never)).rejects.toMatchObject({ code: 'invalid-event' });
    expect(w.rows()).toEqual([]);
  });
  it('does not authenticate an untrusted or synthetic issuer, nor accept an actor other than the requester', async () => {
    const w = world(); await w.ready;
    const synthetic = { kind: 'verified' as const, principal: { issuer: 'control-plane:client-a', subject: 'bootstrap', kind: 'staff' as const }, sessionId: 'sess_cp' as never };
    await expect(w.log(synthetic).append(event({}, synthetic))).rejects.toMatchObject({ code: 'invalid-event' });
    await expect(w.log().append(event({}, admin))).rejects.toMatchObject({ code: 'invalid-event' });
    await expect(w.log(anonymous).append(event({}, viewer))).rejects.toMatchObject({ code: 'invalid-event' });
    await expect(w.log(anonymous).append(event({ outcome: 'denied' }, anonymous))).resolves.toBeTruthy();
    expect(() => auditConfig({ clientId: 'client-a', trustedIssuers: ['control-plane:client-a'], limits: config().limits })).toThrow(TypeError);
    expect(() => auditConfig({ clientId: 'client-a', trustedIssuers: [ISSUER_A], limits: { ...config().limits, maxPageRows: 10_000 } })).toThrow(TypeError);
  });
});

describe('client binding', () => {
  it('never binds an empty database from a request: an unbound log refuses and leaves it empty', async () => {
    const w = world({ bind: false });
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable' });
    await expect(w.log().find('evt-1')).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect(w.db.prepare('SELECT count(*) AS n FROM native_audit_binding').get()).toEqual({ n: 0 });
  });
  it('refuses a database bound to another client, and its events stay invisible', async () => {
    const b = world({ clientId: 'client-b' }); await b.ready;
    await b.log({ kind: 'verified', principal: { issuer: ISSUER_A, subject: 'user_a1', kind: 'client' }, sessionId: 's' as never }).append(event({ eventId: 'evt-b' }));
    const asA = createD1AuditLog({ db: b.d1, config: config('client-a'), requester: viewer, gate: gate({ cases: { user_a1: ['case-a1'] } }), now: NOW });
    await expect(asA.append(event())).rejects.toMatchObject({ code: 'audit-unavailable' });
    await expect(asA.find('evt-b')).rejects.toMatchObject({ code: 'audit-unavailable' });
    await expect(provisionAuditBinding({ db: b.d1, config: config('client-a'), now: NOW })).rejects.toThrow(TypeError);
    expect(() => b.db.prepare("INSERT INTO native_audit_events (event_id, client_id, envelope, action, object_kind, object_id, outcome, actor_kind, at, canonical, sha256) VALUES ('x', 'client-a', 1, 'a', 'k', 'i', 'denied', 'anonymous', 't', '{}', ?)").run('0'.repeat(64))).toThrow(/not bound/);
  });
  it('requires a read gate at construction', () => {
    const w = world();
    expect(() => createD1AuditLog({ db: w.d1, config: w.config, requester: viewer, gate: undefined as never, now: NOW })).toThrow(TypeError);
  });
});

describe('permission-scoped queries', () => {
  async function seeded() {
    const w = world(); await w.ready;
    await w.log().append(event({ eventId: 'a1-read', object: { kind: 'case', id: 'case-a1', caseId: 'case-a1' as never } }));
    await w.log().append(event({ eventId: 'a2-read', object: { kind: 'case', id: 'case-a2', caseId: 'case-a2' as never } }));
    await w.log().append(event({ eventId: 'denied-unscoped', object: { kind: 'case', id: 'case-a2', caseId: null }, outcome: 'denied' }));
    await w.log(admin).append(event({ eventId: 'grant-op:1', action: 'grant.create', object: { kind: 'case-grant', id: 'g-1', caseId: 'case-a1' as never } }, admin));
    await w.log(admin).append(event({ eventId: 'admin-1', action: 'admin.invite', object: { kind: 'invitation', id: 'inv-1', caseId: null } }, admin));
    return w;
  }
  const g = gate({ cases: { user_a1: ['case-a1'] }, administrators: ['user_admin'] });
  it('returns only the granted case activity and audits the read with that case first', async () => {
    const w = await seeded();
    const page = await w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 10 });
    expect(page.events.map((e) => e.eventId).filter((id) => !id.startsWith('audit-read:'))).toEqual(['a1-read', 'grant-op:1']);
    expect(page.events.every((e) => e.object.caseId === 'case-a1')).toBe(true);
    expect(w.rows().filter((r) => r.action === 'audit.read').map((r) => [r.outcome, r.case_id])).toEqual([['succeeded', 'case-a1']]);
  });
  it('refuses ungranted and unknown cases identically, with no case id in the denial event (no oracle)', async () => {
    const w = await seeded();
    const ungranted = w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-a2' as never }, cursor: null, limit: 10 });
    const unknown = w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-zz' as never }, cursor: null, limit: 10 });
    const [x, y] = await Promise.allSettled([ungranted, unknown]);
    expect([x, y].map((r) => r.status === 'rejected' && { code: (r.reason as { code: string }).code, message: (r.reason as Error).message })).toEqual([{ code: 'forbidden', message: 'forbidden' }, { code: 'forbidden', message: 'forbidden' }]);
    expect(w.rows().filter((r) => r.action === 'audit.read').map((r) => [r.outcome, r.case_id])).toEqual([['denied', null], ['denied', null]]);
  });
  it('a grant administrator without a case grant cannot read case activity; the administration view hides case activity', async () => {
    const w = await seeded();
    await expect(w.log(admin, g).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 10 })).rejects.toMatchObject({ code: 'forbidden' });
    const page = await w.log(admin, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 10 });
    expect(page.events.map((e) => e.eventId).filter((id) => !id.startsWith('audit-read:'))).toEqual(['admin-1']);
    expect(page.events.every((e) => e.object.caseId === null && e.object.kind !== 'case')).toBe(true);
    await expect(w.log(viewer, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 10 })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('refuses anonymous readers, bad cursors and limits, and serves no rows when the read cannot be audited', async () => {
    const w = await seeded();
    await expect(w.log(anonymous, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 10 })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: '1 OR 1=1', limit: 10 })).rejects.toMatchObject({ code: 'invalid-query' });
    await expect(w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 51 })).rejects.toMatchObject({ code: 'invalid-query' });
    w.fault.failInsert = true;
    await expect(w.log(viewer, g).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 10 })).rejects.toMatchObject({ code: 'audit-unavailable' });
    // a denied read whose own audit fails still refuses once, without retrying or recursing
    const calls = gate({});
    await expect(w.log(viewer, calls).query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 10 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls.calls).toEqual(['case:case-a1']);
  });
  it('pages with an opaque cursor and stops at the per-request page budget', async () => {
    const w = await seeded();
    const log = w.log(viewer, g), q = (cursor: string | null) => log.query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor, limit: 1 });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) { const p = await q(cursor); seen.push(...p.events.map((e) => e.eventId)); cursor = p.next; if (!cursor) break; }
    expect(seen.slice(0, 2)).toEqual(['a1-read', 'grant-op:1']);
    expect(new Set(seen).size).toBe(seen.length);
    const budget = w.log(viewer, g);
    for (let i = 0; i < 5; i++) await budget.query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 1 });
    await expect(budget.query({ scope: { kind: 'case', caseId: 'case-a1' as never }, cursor: null, limit: 1 })).rejects.toMatchObject({ code: 'audit-budget' });
  });
});
