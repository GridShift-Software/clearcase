// GRS-116 fix round 1: the owned facades, separated capacity classes, denial bounds and the public event shape.
// node:sqlite stand-in only: unit results, not D1, workerd or provider evidence.
import { describe, expect, it } from 'vitest';
import type { IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { auditConfig, publicAuditReader, requestAuditSink } from '../../../src/lib/audit/index.ts';
import * as publicSurface from '../../../src/lib/audit/index.ts';
import { trustedGrantAuditPort } from '../../../src/lib/audit/trusted.ts';
import { admin, anonymous, config, event, gate, ISSUER_A, NOW, viewer, world } from './world.ts';

const ask = { scope: { kind: 'case' as const, caseId: 'case-a1' as never }, cursor: null, limit: 10 };
const binding = (w: ReturnType<typeof world>) => w.db.prepare('SELECT event_count, read_count, denial_count, denial_unlogged FROM native_audit_binding').get();
const others = (w: ReturnType<typeof world>) => w.rows().filter((r) => r.action === 'audit.read');
const reserved = (id: string) => event({ eventId: id, action: 'audit.read', object: { kind: 'audit-log', id: 'case', caseId: null } });

describe('owned facades', () => {
  it('hands a request route append and atomic, a reader only query, and the grant port append and find', async () => {
    const w = world(); await w.ready;
    const common = { db: w.d1, config: w.config, requester: viewer, now: NOW };
    const sink = requestAuditSink(common), reader = publicAuditReader({ ...common, gate: gate() }), port = trustedGrantAuditPort(common);
    const surface = (o: object) => { const names = new Set<string>(); for (let p: object | null = o; p; p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => names.add(n)); return [...names].filter((n) => !['constructor', '__proto__', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(n)).sort(); };
    expect(surface(sink)).toEqual(['append', 'atomic']);
    expect(surface(reader)).toEqual(['query']);
    expect(surface(port)).toEqual(['append', 'find']);
    expect([sink, reader, port].map(Object.isFrozen)).toEqual([true, true, true]);
    const e = event();
    await expect(sink.append(e)).resolves.toEqual({ eventId: e.eventId });
    await expect(port.find(e.eventId)).resolves.toEqual(e);
    expect('find' in sink).toBe(false);
    expect((sink as unknown as { find?: unknown }).find).toBeUndefined();
    expect(() => publicAuditReader({ ...common, gate: undefined as never })).toThrow(TypeError);
  });
  it('keeps provisioning, find and the full log out of the public index', () => {
    expect(Object.keys(publicSurface).sort()).toEqual(['AUDIT_MIGRATIONS', 'CEILINGS', 'ENVELOPE', 'auditConfig', 'canonical', 'publicAuditReader', 'requestAuditSink', 'sha256Hex']);
  });
  it('reserves the audit.read action to the log itself', async () => {
    const w = world(); await w.ready;
    await expect(w.log().append(reserved('forged-read'))).rejects.toMatchObject({ code: 'invalid-event' });
    expect(w.rows()).toEqual([]);
  });
});

describe('capacity classes', () => {
  it('bounds denials per actor and overall, still refuses uniformly, counts the unlogged, and leaves other actors and reads working', async () => {
    const w = world({ over: { maxPagesPerRequest: 20, maxDenialsPerActor: 4, maxDenialRows: 6 } }); await w.ready;
    const g = gate({ cases: { user_admin: ['case-a1'] } });
    const outcomes = new Set<string>();
    for (let r = 0; r < 3; r++) for (let i = 0; i < 20; i++) outcomes.add(await w.log(viewer, g).query(ask).then(() => 'served', (e: { code: string; message: string }) => `${e.code}:${e.message}`));
    expect([...outcomes]).toEqual(['forbidden:forbidden']);
    expect(others(w).map((r) => r.outcome)).toEqual(['denied', 'denied', 'denied', 'denied']);
    expect(binding(w)).toEqual({ event_count: 0, read_count: 0, denial_count: 4, denial_unlogged: 56 });
    // another actor's denials are still kept, up to the shared bound, and a granted reader is unaffected
    const other: IdentityState = { kind: 'verified', principal: { issuer: ISSUER_A, subject: 'user_other', kind: 'client' }, sessionId: 'sess_o' as never };
    for (let i = 0; i < 10; i++) await expect(w.log(other, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    expect(binding(w)).toMatchObject({ denial_count: 6 });
    const page = await w.log(admin, g).query(ask);
    expect(page.events.length).toBeGreaterThan(0);
    expect(binding(w)).toMatchObject({ read_count: 1, event_count: 0 });
  });
  it('an ungranted read stays denied when its event cannot be stored, never an unlogged allow', async () => {
    const w = world({ over: { maxDenialRows: 1, maxDenialsPerActor: 1 } }); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] } });
    await expect(w.log(admin, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    w.fault.failInsert = true;
    await expect(w.log(admin, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.log(viewer, g).query(ask)).rejects.toMatchObject({ code: 'audit-unavailable' });
  });
  it('read capacity is its own class: when spent, reads fail closed, protected appends and denials continue', async () => {
    const w = world({ over: { maxReadRows: 2, maxRows: 2 } }); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] } });
    await w.log().append(event({ eventId: 'e-1' }));
    for (let i = 0; i < 2; i++) await w.log(viewer, g).query(ask);
    await expect(w.log(viewer, g).query(ask)).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    await expect(w.log(admin, g).query(ask)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.log().append(event({ eventId: 'e-2' }))).resolves.toBeTruthy();
    await expect(w.log().append(event({ eventId: 'e-3' }))).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    expect(binding(w)).toEqual({ event_count: 2, read_count: 2, denial_count: 1, denial_unlogged: 0 });
  });
  it('the schema ties each class to its action and moves counters only by the insert trigger', async () => {
    const w = world(); await w.ready;
    const insert = (cls: string, action: string, outcome: string) => () => w.db.prepare(`INSERT INTO native_audit_events (event_id, client_id, envelope, class, action, object_kind, object_id, outcome, actor_kind, at, canonical, sha256) VALUES ('c-${cls}-${action}-${outcome}', 'client-a', 1, ?, ?, 'k', 'i', ?, 'anonymous', 't', '{}', ?)`).run(cls, action, outcome, '0'.repeat(64));
    expect(insert('protected', 'audit.read', 'succeeded')).toThrow(/CHECK/);
    expect(insert('read', 'case.read', 'succeeded')).toThrow(/CHECK/);
    expect(insert('denial', 'audit.read', 'succeeded')).toThrow(/CHECK/);
    expect(() => w.db.exec('UPDATE native_audit_binding SET event_count = event_count + 2')).toThrow(/counters only grow/);
    expect(() => w.db.exec('UPDATE native_audit_binding SET event_count = event_count + 1')).not.toThrow(); // direct admin DML can inflate, never reset
    expect(() => w.db.exec('DELETE FROM native_audit_binding')).toThrow(/permanent/);
  });
});

describe('public event shape', () => {
  it('names the actor safely, marks own events, and never carries a session or the stored envelope', async () => {
    const w = world(); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] }, administrators: ['user_admin'] });
    await w.log().append(event({ eventId: 'mine' }));
    await w.log(admin).append(event({ eventId: 'theirs' }, admin));
    const page = await w.log(viewer, g).query(ask);
    const mine = page.events.find((e) => e.eventId === 'mine'), theirs = page.events.find((e) => e.eventId === 'theirs');
    expect(mine?.actor).toEqual({ kind: 'verified', issuer: ISSUER_A, subject: 'user_a1', principalKind: 'client', self: true });
    expect(theirs?.actor).toEqual({ kind: 'verified', issuer: ISSUER_A, subject: 'user_admin', principalKind: 'client', self: false });
    expect(Object.keys(mine ?? {}).sort()).toEqual(['action', 'actor', 'at', 'eventId', 'object', 'outcome', 'version']);
    expect(JSON.stringify(page)).not.toMatch(/sess_|sessionId|envelope|canonical|sha256/);
    await w.log(anonymous).append(event({ eventId: 'anon', object: { kind: 'invitation', id: 'inv-2', caseId: null }, outcome: 'denied' }, anonymous));
    const adminPage = await w.log(admin, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 20 });
    expect(adminPage.events.find((e) => e.eventId === 'anon')?.actor).toEqual({ kind: 'anonymous' });
  });
  it('the administration view never shows a versioned (case) event even when its case id is missing', async () => {
    const w = world(); await w.ready;
    const g = gate({ administrators: ['user_admin'] });
    await w.log().append(event({ eventId: 'versioned', object: { kind: 'note', id: 'n-1', caseId: null }, version: 'v-1' as never }));
    await w.log().append(event({ eventId: 'plain-admin', action: 'admin.invite', object: { kind: 'invitation', id: 'inv-1', caseId: null } }));
    const page = await w.log(admin, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 20 });
    expect(page.events.map((e) => e.eventId).filter((id) => !id.startsWith('audit-read:'))).toEqual(['plain-admin']);
  });
});

describe('configuration', () => {
  it('requires every limit, including the read and denial bounds, under their ceilings', () => {
    const { maxReadRows, ...missing } = config().limits;
    expect(maxReadRows).toBeGreaterThan(0);
    for (const bad of [missing, { ...config().limits, maxDenialRows: 0 }, { ...config().limits, maxDenialsPerActor: 1_001 }, { ...config().limits, maxReadRows: 50_000_001 }]) expect(() => auditConfig({ clientId: 'client-a', trustedIssuers: [ISSUER_A], limits: bad })).toThrow(TypeError);
  });
});
