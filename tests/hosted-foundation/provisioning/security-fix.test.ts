// GRS-114 security fix round 1: adverse regressions for the HOLD review (H1, M1, M2, M3). Written first and run against
// the unfixed base. Unit stand-ins only (node:sqlite, in-memory duplicate-refusing audit); not D1/Clerk evidence.
import { describe, expect, it } from 'vitest';
import type { CaseOperation } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { CASE_1, SESSION, SESSION_2, client, staff, world } from './world.ts';

const admin = client('user_admin'), other = client('user_other_admin'), alice = client('user_alice'), mallory = client('user_mallory');
type Role = 'viewer' | 'editor' | 'operator' | 'publisher' | 'grant-admin';
function setup() {
  const w = world();
  w.seed(admin, 'grant-admin', null);
  w.seed(other, 'grant-admin', null); // an independently authorised manager (trusted bootstrap stands in as a seed)
  const create = (by: typeof admin, op: string, target = alice, role: Role = 'viewer', caseId: string | null = CASE_1, session = SESSION) =>
    w.manage.create({ actor: w.actor(by, session), operationId: op, target, role, caseId: caseId === null ? null : id('case', caseId), expiresAt: null });
  const can = (p: typeof admin, operation: CaseOperation = 'read') => w.authorizeCase({ principal: p, sessionId: SESSION, caseId: CASE_1, operation }).then(() => 'allowed', (e) => e.code as string);
  const revokeOf = (by: typeof admin, op: string, grantId: string, v: number, session = SESSION) => w.manage.revoke({ actor: w.actor(by, session), operationId: op, grantId, expectedVersion: v });
  return { w, create, can, revokeOf };
}
const pendingCreate = async (s: ReturnType<typeof setup>, op: string) => {
  s.w.state.auditFails = true;
  const r = await s.create(admin, op);
  s.w.state.auditFails = false;
  if (r.kind !== 'audit-pending') throw new Error('setup');
  return r;
};

describe('H1: management authority is not mintable by a manager', () => {
  it('a grant manager cannot delegate grant-admin, so A -> B(grant-admin) -> A(editor) never reaches case content', async () => {
    const { w, create, can } = setup(), b = client('user_alt_of_admin');
    await expect(create(admin, 'op-1', b, 'grant-admin', null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(create(admin, 'op-1', b, 'grant-admin', null)).rejects.toMatchObject({ code: 'forbidden' }); // the retry path is refused too
    await expect(create(b, 'op-2', admin, 'editor')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await can(admin, 'write-user-work')).toBe('forbidden');
    expect(w.rows()).toHaveLength(2); // the two seeds only
    expect(w.events.filter((e) => e.outcome === 'denied' && e.action.startsWith('grant.')).map((e) => e.action)).toEqual(['grant.create', 'grant.create', 'grant.create']);
  });
  it('an update cannot mint or extend management authority either: no role transition into grant-admin, no change of a grant-admin grant', async () => {
    const { w, create, can } = setup();
    const made = await create(admin, 'op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    await expect(w.manage.update({ actor: w.actor(admin), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'grant-admin', expiresAt: null })).rejects.toMatchObject({ code: 'forbidden' });
    const mine = w.rows().find((r) => (r as { role: string }).role === 'grant-admin') as { grant_id: string; version: number };
    await expect(w.manage.update({ actor: w.actor(other), operationId: 'op-up2', grantId: mine.grant_id, expectedVersion: mine.version, role: 'grant-admin', expiresAt: '2027-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await can(alice)).toBe('allowed');
  });
  it('still refuses a direct self-grant, and still lets an independently authorised manager grant case roles explicitly', async () => {
    const { create, can } = setup();
    await expect(create(admin, 'op-self', admin, 'editor')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await create(other, 'op-1', admin, 'editor')).toMatchObject({ kind: 'applied' }); // explicit and audited; code cannot tell whether two humans collude
    expect(await can(admin, 'write-user-work')).toBe('allowed');
  });
});

describe('M1: an operation id is bound to its original actor', () => {
  it('another manager cannot resume a pending create with the first actor\'s operation id', async () => {
    const s = setup(), { w, create, can } = s;
    const pending = await pendingCreate(s, 'op-1');
    expect(await create(other, 'op-1')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await can(alice)).toBe('forbidden');
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-1')).toEqual([]);
    expect(w.rows().find((r) => (r as { grant_id: string }).grant_id === pending.grantId)).toMatchObject({ state: 'pending' });
    expect(await create(admin, 'op-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { createdBy: { issuer: admin.issuer, subject: admin.subject } } }); // the original actor resumes
  });
  it('another manager cannot resume or read the result of a pending update', async () => {
    const { w, create } = setup();
    const made = await create(admin, 'op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    w.state.auditFails = true;
    const up = (by: typeof admin) => w.manage.update({ actor: w.actor(by), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null });
    expect(await up(admin)).toMatchObject({ kind: 'audit-pending' });
    w.state.auditFails = false;
    expect(await up(other)).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-up')).toEqual([]);
    expect(await up(admin)).toMatchObject({ kind: 'applied', repeated: true, grant: { role: 'editor', state: 'active' } });
  });
  it('another manager cannot resume or read the result of a pending revoke', async () => {
    const { w, create, revokeOf } = setup();
    const made = await create(admin, 'op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    w.state.auditFails = true;
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'audit-pending' });
    w.state.auditFails = false;
    expect(await revokeOf(other, 'op-r', made.grant.grantId, 2)).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-r')).toEqual([]);
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'applied', repeated: true });
  });
  it('the same principal on a new session resumes with the stable original event: same actor, session and instant', async () => {
    const s = setup(), { w, create } = s;
    await pendingCreate(s, 'op-1');
    const first = w.actor(admin).sessionId;
    w.advance(60_000);
    expect(await create(admin, 'op-1', alice, 'viewer', CASE_1, SESSION_2)).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-1')).toMatchObject([{ actor: { kind: 'verified', principal: admin, sessionId: first }, at: '2026-10-24T12:00:00.000Z' }]);
  });
});

describe('M2: audit retries are exactly idempotent against a duplicate-refusing sink', () => {
  it('a create whose append persisted but lost its acknowledgement settles on retry from the matching event, appended once', async () => {
    const { w, create, can } = setup();
    w.state.lostAck = true; w.state.findFails = true;
    expect(await create(admin, 'op-1')).toMatchObject({ kind: 'audit-pending' });
    expect(await can(alice)).toBe('forbidden');
    w.state.lostAck = false; w.state.findFails = false;
    expect(await create(admin, 'op-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active' } });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-1')).toHaveLength(1);
    expect(await can(alice)).toBe('allowed');
  });
  it('a finished revoke retried reports applied without appending again', async () => {
    const { w, create, revokeOf } = setup();
    const made = await create(admin, 'op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'applied', repeated: false });
    const appends = w.state.appends;
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'revoked' } });
    expect(w.state.appends).toBe(appends);
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-r')).toHaveLength(1);
  });
  it('a revoke whose acknowledgement was lost settles on retry from the persisted event', async () => {
    const { w, create, revokeOf } = setup();
    const made = await create(admin, 'op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    w.state.lostAck = true; w.state.findFails = true;
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'audit-pending' });
    w.state.lostAck = false; w.state.findFails = false;
    expect(await revokeOf(admin, 'op-r', made.grant.grantId, 2)).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-r')).toHaveLength(1);
  });
  it('an event already under the id with different bytes is refused and never activates the grant', async () => {
    const { w, create, can } = setup();
    w.events.push({ eventId: 'grant-op:op-1', actor: { kind: 'verified', principal: other, sessionId: SESSION }, action: 'grant.create', object: { kind: 'case-grant', id: 'forged', caseId: null }, version: null, outcome: 'succeeded', at: '2026-10-24T12:00:00.000Z' });
    expect(await create(admin, 'op-1')).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(await can(alice)).toBe('forbidden');
  });
  it('a pending create revoked in the meantime never activates on retry, whatever the audit sink did', async () => {
    const { w, create, can, revokeOf } = setup();
    w.state.lostAck = true; w.state.findFails = true;
    const r = await create(admin, 'op-1');
    if (r.kind !== 'audit-pending') throw new Error('setup');
    w.state.lostAck = false; w.state.findFails = false;
    expect(await revokeOf(other, 'op-r', r.grantId, 1)).toMatchObject({ kind: 'applied', grant: { state: 'revoked' } });
    expect(await create(admin, 'op-1')).toEqual({ kind: 'stale' });
    expect(await can(alice)).toBe('forbidden');
  });
});

describe('M3: client access and verified denials are audited, permission-scoped, and fail closed', () => {
  it('a client read appends a succeeded event with the verified actor, and is refused when that cannot persist', async () => {
    const { w } = setup();
    w.seed(alice, 'viewer', CASE_1);
    await expect(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'read' })).resolves.toBeUndefined();
    expect(w.events).toMatchObject([{ action: 'case.read', outcome: 'succeeded', actor: { kind: 'verified', principal: alice, sessionId: SESSION }, object: { kind: 'case', id: 'case-1', caseId: 'case-1' } }]);
    w.state.auditFails = true;
    await expect(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'read' })).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
    await expect(w.authorizeCapability({ principal: alice, sessionId: SESSION, caseId: CASE_1, capability: 'operate' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a client write by an editor is audited as an access, not only a staff one', async () => {
    const { w } = setup();
    w.seed(alice, 'editor', CASE_1);
    await w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' });
    expect(w.events).toMatchObject([{ action: 'case.write-user-work', outcome: 'succeeded' }]);
  });
  it('a denial for a principal with no effective grant is not scoped to the case, nor is an unknown case or a foreign client\'s', async () => {
    const { w } = setup(), ghost = id('case', 'case-ghost');
    w.seed(alice, 'viewer', 'case-ghost'); // a grant for a case that does not exist
    await w.authorizeCase({ principal: mallory, sessionId: SESSION, caseId: CASE_1, operation: 'read' }).catch(() => undefined);
    await w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: ghost, operation: 'read' }).catch(() => undefined);
    await w.authorizeCase({ principal: client('user_x', 'https://client-c.example.test'), sessionId: SESSION, caseId: CASE_1, operation: 'read' }).catch(() => undefined);
    expect(w.events.map((e) => [e.outcome, e.object.caseId])).toEqual([['denied', null], ['denied', null], ['denied', null]]);
  });
  it('a denial for a principal who does hold a grant on the case is scoped to it; a management denial is never scoped to the named case', async () => {
    const { w, create } = setup();
    w.seed(alice, 'viewer', CASE_1);
    await w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' }).catch(() => undefined);
    await create(mallory, 'op-m', alice, 'viewer', CASE_1).catch(() => undefined);
    expect(w.events.map((e) => [e.action, e.outcome, e.object.caseId])).toEqual([['case.write-user-work', 'denied', 'case-1'], ['grant.create', 'denied', null]]);
  });
  it('a staff denial is recorded without the case label being trusted', async () => {
    const { w } = setup();
    await w.authorizeCase({ principal: staff('staff_x'), sessionId: SESSION, caseId: CASE_1, operation: 'read' }).catch(() => undefined);
    expect(w.events).toMatchObject([{ outcome: 'denied', object: { caseId: null } }]);
  });
});
