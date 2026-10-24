// GRS-114 fix round 1: the trusted bootstrap authority, the audit-port dependency, the ledger, and storage faults.
import { describe, expect, it } from 'vitest';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { createGrantManagement, createManagerBootstrap } from '../../../src/lib/tenancy/management.ts';
import { CASE_1, ISSUER_A, ISSUER_C, SESSION, SESSION_2, client, staff, world } from './world.ts';

const root = { operator: 'provisioning-run-1' }, admin = client('user_admin'), alice = client('user_alice'), ga = staff('staff_ga');
const boot = (w: ReturnType<typeof world>, op: string, target = admin, who = root.operator, expiresAt: string | null = null) => w.bootstrap.grantManager({ operator: who, operationId: op, target, expiresAt });
const outcome = (p: Promise<void>) => p.then(() => 'allowed', (e: { code?: string }) => e.code ?? 'thrown');

describe('trusted manager bootstrap', () => {
  it('grants the first grant-admin, audited and idempotent; that manager then makes explicit case grants but cannot delegate management', async () => {
    const w = world();
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'applied', repeated: false, grant: { role: 'grant-admin', state: 'active', scope: { kind: 'client' }, createdBy: { issuer: 'control-plane:client-a', subject: 'provisioning-run-1' } } });
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.events.filter((e) => e.action === 'grant.bootstrap')).toMatchObject([{ eventId: 'grant-op:boot-1', outcome: 'succeeded', object: { kind: 'case-grant', caseId: null }, actor: { principal: { issuer: 'control-plane:client-a', subject: 'provisioning-run-1' } } }]);
    expect(await w.manage.create({ actor: w.actor(admin), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).toMatchObject({ kind: 'applied' });
    await expect(w.manage.create({ actor: w.actor(admin), operationId: 'op-2', target: ga, role: 'grant-admin', caseId: null, expiresAt: null })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await boot(w, 'boot-2', ga)).toMatchObject({ kind: 'applied' }); // a further manager is again the control plane's decision
  });
  it('confers no case content, and its actor label authorizes nothing', async () => {
    const w = world();
    await boot(w, 'boot-1');
    expect(await outcome(w.authorizeCase({ principal: admin, sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).toBe('forbidden');
    const label = { issuer: 'control-plane:client-a', subject: 'provisioning-run-1', kind: 'staff' } as const;
    expect(await outcome(w.authorizeCase({ principal: label, sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).toBe('wrong-client');
  });
  it('a taken slot, a foreign target, a bad label and a past expiry write nothing', async () => {
    const w = world();
    await boot(w, 'boot-1');
    expect(await boot(w, 'boot-2')).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    expect(await boot(w, 'boot-3', client('x', ISSUER_C))).toMatchObject({ kind: 'invalid' });
    expect(await boot(w, 'boot-4', alice, 'bad operator!')).toMatchObject({ kind: 'invalid' });
    expect(await boot(w, 'boot-5', alice, root.operator, '2026-10-24T11:00:00.000Z')).toMatchObject({ kind: 'invalid' });
    expect(w.rows()).toHaveLength(1);
  });
  it('an operation id belongs to the operator and request that first used it, and to no manager', async () => {
    const w = world();
    w.state.auditFails = true;
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'audit-pending' });
    w.state.auditFails = false;
    expect(await boot(w, 'boot-1', admin, 'another-run')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await boot(w, 'boot-1', ga)).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active' } });
    expect(await w.manage.create({ actor: w.actor(admin), operationId: 'boot-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).toEqual({ kind: 'conflict', reason: 'operation-reused' });
  });
  it('is pending until its event persists, and survives a lost acknowledgement without appending twice', async () => {
    const w = world();
    w.state.lostAck = true; w.state.findFails = true;
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'audit-pending' });
    expect(await outcome(w.authorizeCase({ principal: admin, sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).toBe('forbidden');
    w.state.lostAck = false; w.state.findFails = false;
    const appends = w.state.appends;
    expect(await boot(w, 'boot-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active' } });
    expect(w.state.appends).toBe(appends);
    expect(w.events.filter((e) => e.eventId === 'grant-op:boot-1')).toHaveLength(1);
  });
});

describe('the audit port and the operation ledger', () => {
  it('management and the bootstrap refuse to start on a plain append-only sink', () => {
    const w = world(), plain = { append: w.audit.append };
    const base = { deployment: undefined as never, grants: undefined as never, now: () => new Date() };
    expect(() => createGrantManagement({ ...base, cases: undefined as never, audit: plain as never })).toThrow(TypeError);
    expect(() => createManagerBootstrap({ ...base, audit: plain as never })).toThrow(TypeError);
    expect(() => createCaseAuthorizer({ ...base, cases: undefined as never, audit: undefined as never })).toThrow(TypeError);
  });
  it('an update whose acknowledgement was lost removes the old access at once and settles from the persisted event', async () => {
    const w = world(), a = client('user_admin2');
    w.seed(a, 'grant-admin', null);
    const made = await w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null });
    if (made.kind !== 'applied') throw new Error('setup');
    const up = () => w.manage.update({ actor: w.actor(a), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null });
    w.state.lostAck = true; w.state.findFails = true;
    expect(await up()).toMatchObject({ kind: 'audit-pending' });
    expect(await outcome(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).toBe('forbidden');
    w.state.lostAck = false; w.state.findFails = false;
    expect(await up()).toMatchObject({ kind: 'applied', repeated: true, grant: { role: 'editor', state: 'active' } });
    expect(w.events.filter((e) => e.eventId === 'grant-op:op-up')).toHaveLength(1);
    expect(await outcome(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' }))).toBe('allowed');
  });
  it('the recorded event is fixed: a tampered ledger row is refused and never activates the grant', async () => {
    const w = world(), a = client('user_admin2');
    w.seed(a, 'grant-admin', null);
    w.state.auditFails = true;
    await w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null });
    w.state.auditFails = false;
    w.db.prepare("UPDATE tenant_grant_operations SET event_json = replace(event_json, 'user_admin2', 'user_other')").run();
    expect(await w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(w.events).toEqual([]);
  });
  it('a completed operation never appends again, and a replay after revocation reports the revoked grant, not an active one', async () => {
    const w = world(), a = client('user_admin2');
    w.seed(a, 'grant-admin', null);
    const made = await w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null });
    if (made.kind !== 'applied') throw new Error('setup');
    const up = await w.manage.update({ actor: w.actor(a), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null });
    if (up.kind !== 'applied') throw new Error('setup');
    expect(await w.manage.revoke({ actor: w.actor(a), operationId: 'op-r', grantId: up.grant.grantId, expectedVersion: up.grant.version })).toMatchObject({ kind: 'applied' });
    const appends = w.state.appends;
    expect(await w.manage.update({ actor: w.actor(a, SESSION_2), operationId: 'op-up', grantId: made.grant.grantId, expectedVersion: 2, role: 'editor', expiresAt: null })).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'revoked' } });
    expect(await outcome(w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' }))).toBe('forbidden');
    expect(w.state.appends).toBe(appends + 1); // only the denied access above; the replay appended nothing
  });
});

describe('storage faults and exact identity', () => {
  it('a D1 failure is storage-unavailable and retryable, not a lost race, and the operation id stays usable', async () => {
    const w = world(), a = client('user_admin2');
    w.seed(a, 'grant-admin', null);
    w.state.batchFails = true;
    await expect(w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.rows()).toHaveLength(1);
    w.state.batchFails = false;
    expect(await w.manage.create({ actor: w.actor(a), operationId: 'op-1', target: alice, role: 'viewer', caseId: CASE_1, expiresAt: null })).toMatchObject({ kind: 'applied', repeated: false });
  });
  it('an issuer is compared exactly: a trailing slash, another case or a port is another issuer', async () => {
    const w = world();
    w.seed(alice, 'viewer', CASE_1);
    for (const issuer of [`${ISSUER_A}/`, ISSUER_A.toUpperCase(), 'https://client-a.example.test:443']) {
      expect(await outcome(w.authorizeCase({ principal: client('user_alice', issuer), sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).toBe('wrong-client');
    }
  });
  it('a denial event never echoes an ill-formed requested case id', async () => {
    const w = world();
    await w.authorizeCase({ principal: alice, sessionId: SESSION, caseId: 'x'.repeat(500) as never, operation: 'read' }).catch(() => undefined);
    expect(w.events).toMatchObject([{ outcome: 'denied', object: { id: 'invalid', caseId: null } }]);
    expect(id('case', 'case-1')).toBe(CASE_1);
  });
});
