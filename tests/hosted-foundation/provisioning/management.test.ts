import { describe, expect, it } from 'vitest';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { CASE_1, ISSUER_C, SESSION, client, staff, world } from './world.ts';

const admin = client('user_admin'), alice = client('user_alice');
function managed() {
  const w = world();
  w.seed(admin, 'grant-admin', null);
  const create = (op: string, role: 'viewer' | 'editor' | 'operator' | 'publisher' | 'grant-admin' = 'viewer', target = alice, by = admin, caseId: string | null = CASE_1, expiresAt: string | null = null) =>
    w.manage.create({ actor: w.actor(by), operationId: op, target, role, caseId: caseId === null ? null : id('case', caseId), expiresAt });
  const read = () => w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'read' }).then(() => 'allowed', (e) => e.code);
  const write = () => w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' }).then(() => 'allowed', (e) => e.code);
  return { w, create, read, write };
}

describe('grant management authorization', () => {
  it('refuses a manager without a grant-admin grant, including a case editor, and records the denial', async () => {
    const { w, create } = managed(), editor = client('user_editor');
    w.seed(editor, 'editor', CASE_1);
    await expect(create('op-1', 'viewer', alice, editor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(create('op-2', 'viewer', alice, staff('staff_member'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.events.map((e) => [e.action, e.outcome])).toEqual([['grant.create', 'denied'], ['grant.create', 'denied']]);
    expect(w.rows()).toHaveLength(2); // the two seeds, nothing new
  });
  it('refuses another client issuer as wrong-client and a missing session as unauthenticated', async () => {
    const { w } = managed();
    await expect(w.manage.create({ actor: w.actor(client('user_admin', ISSUER_C)), operationId: 'op', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).rejects.toMatchObject({ code: 'wrong-client' });
    await expect(w.manage.create({ actor: { principal: admin, sessionId: null as never }, operationId: 'op', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('refuses self-granting and changing one\'s own grants', async () => {
    const { w, create } = managed();
    await expect(create('op-self', 'editor', admin)).rejects.toMatchObject({ code: 'forbidden' });
    const mine = w.seed(admin, 'viewer', CASE_1);
    await expect(w.manage.update({ actor: w.actor(admin), operationId: 'op-up', grantId: mine, expectedVersion: 1, role: 'editor', expiresAt: null })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a grant-admin grant reaches no case content', async () => {
    const { w } = managed();
    await expect(w.authorizeCase({ principal: admin, sessionId: SESSION, caseId: CASE_1, operation: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects foreign targets, unknown cases, wrong scope and past expiry without writing', async () => {
    const { w, create } = managed();
    expect(await create('op-a', 'viewer', client('x', ISSUER_C))).toMatchObject({ kind: 'invalid' });
    expect(await create('op-b', 'viewer', alice, admin, 'case-ghost')).toEqual({ kind: 'invalid', reason: 'unknown case' });
    expect(await create('op-c', 'grant-admin', alice, admin, CASE_1)).toMatchObject({ kind: 'invalid' });
    expect(await create('op-d', 'viewer', alice, admin, null)).toMatchObject({ kind: 'invalid' });
    expect(await create('op-e', 'viewer', alice, admin, CASE_1, '2026-10-24T11:00:00.000Z')).toMatchObject({ kind: 'invalid' });
    expect(w.rows()).toHaveLength(1);
  });
});

describe('grant management changes', () => {
  it('creates an audited grant that takes effect, for client users and explicit staff alike', async () => {
    const { w, create, read } = managed();
    expect(await read()).toBe('forbidden');
    const r = await create('op-1');
    expect(r).toMatchObject({ kind: 'applied', repeated: false, grant: { state: 'active', role: 'viewer', version: 2 } });
    expect(await read()).toBe('allowed');
    expect(w.events.filter((e) => e.outcome === 'succeeded' && e.action.startsWith('grant.'))).toMatchObject([{ eventId: 'grant-op:op-1', action: 'grant.create', object: { kind: 'case-grant', caseId: 'case-1' }, actor: { principal: admin } }]);
    expect(await create('op-2', 'operator', staff('staff_op'))).toMatchObject({ kind: 'applied' });
  });
  it('a duplicate operation is repeated once; the same id with another request conflicts; a second grant in the slot conflicts', async () => {
    const { w, create } = managed();
    const first = await create('op-1');
    expect(await create('op-1')).toEqual({ ...first, repeated: true });
    expect(await create('op-1', 'editor')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await create('op-2', 'editor')).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    expect(w.rows()).toHaveLength(2);
  });
  it('updates by compare-and-set: viewer to editor at the current version, stale otherwise, and only within the slot', async () => {
    const { w, create, write } = managed();
    const made = await create('op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    expect(await w.manage.update({ actor: w.actor(admin), operationId: 'op-stale', grantId: made.grant.grantId, expectedVersion: 1, role: 'editor', expiresAt: null })).toEqual({ kind: 'stale' });
    expect(await w.manage.update({ actor: w.actor(admin), operationId: 'op-slot', grantId: made.grant.grantId, expectedVersion: 2, role: 'publisher', expiresAt: null })).toMatchObject({ kind: 'invalid' });
    expect(await write()).toBe('forbidden');
    const up = await w.manage.update({ actor: w.actor(admin), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null });
    expect(up).toMatchObject({ kind: 'applied', grant: { role: 'editor', state: 'active', supersedes: made.grant.grantId } });
    expect(await write()).toBe('allowed');
    expect(await w.manage.update({ actor: w.actor(admin), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null })).toMatchObject({ kind: 'applied', repeated: true });
    expect(await w.manage.update({ actor: w.actor(admin), operationId: 'op-up2', grantId: made.grant.grantId, expectedVersion: 2, role: 'viewer', expiresAt: null })).toEqual({ kind: 'stale' });
    expect(await w.manage.update({ actor: w.actor(admin), operationId: 'op-gone', grantId: 'nope', expectedVersion: 1, role: 'viewer', expiresAt: null })).toEqual({ kind: 'gone' });
  });
  it('revokes at once, by compare-and-set, idempotently', async () => {
    const { w, create, read } = managed();
    const made = await create('op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    expect(await w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: made.grant.grantId, expectedVersion: 1 })).toEqual({ kind: 'stale' });
    expect(await w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: made.grant.grantId, expectedVersion: 2 })).toMatchObject({ kind: 'applied', grant: { state: 'revoked' } });
    expect(await read()).toBe('forbidden');
    expect(await w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: made.grant.grantId, expectedVersion: 2 })).toMatchObject({ kind: 'applied', repeated: true });
    expect(await w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: 'other', expectedVersion: 2 })).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await create('op-r')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await create('op-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'revoked' } });
    expect(await create('op-2')).toMatchObject({ kind: 'applied' }); // the slot is free again
  });
});

describe('grant management when the audit append fails', () => {
  it('a create stays pending and grants nothing until a retry with the same operation persists its event', async () => {
    const { w, create, read } = managed();
    w.state.auditFails = true;
    const r = await create('op-1');
    expect(r).toMatchObject({ kind: 'audit-pending', retryable: true });
    expect(await read()).toBe('forbidden');
    expect(await create('op-1')).toMatchObject({ kind: 'audit-pending' });
    w.state.auditFails = false;
    expect(await create('op-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active' } });
    expect(await read()).toBe('allowed');
  });
  it('an update removes the old access at once and grants the new role only after its event persists', async () => {
    const { w, create, read, write } = managed();
    const made = await create('op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    w.state.auditFails = true;
    const up = () => w.manage.update({ actor: w.actor(admin), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null });
    expect(await up()).toMatchObject({ kind: 'audit-pending' });
    expect([await read(), await write()]).toEqual(['forbidden', 'forbidden']);
    w.state.auditFails = false;
    expect(await up()).toMatchObject({ kind: 'applied', repeated: true });
    expect(await write()).toBe('allowed');
  });
  it('a revoke is in force even when its event cannot persist, and a retry records it', async () => {
    const { w, create, read } = managed();
    const made = await create('op-1');
    if (made.kind !== 'applied') throw new Error('setup');
    w.state.auditFails = true;
    const revoke = () => w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: made.grant.grantId, expectedVersion: 2 });
    expect(await revoke()).toMatchObject({ kind: 'audit-pending', retryable: true });
    expect(await read()).toBe('forbidden');
    w.state.auditFails = false;
    expect(await revoke()).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.events.at(-1)).toMatchObject({ eventId: 'grant-op:op-r', action: 'grant.revoke', outcome: 'succeeded' });
  });
  it('a pending grant whose audit never recovers can be revoked to free its slot', async () => {
    const { w, create } = managed();
    w.state.auditFails = true;
    const r = await create('op-1');
    if (r.kind !== 'audit-pending') throw new Error('setup');
    w.state.auditFails = false;
    expect(await w.manage.revoke({ actor: w.actor(admin), operationId: 'op-r', grantId: r.grantId, expectedVersion: 1 })).toMatchObject({ kind: 'applied', grant: { state: 'revoked' } });
    expect(await create('op-2')).toMatchObject({ kind: 'applied' });
  });
});
