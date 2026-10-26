// Integration of real adapters on synthetic schemas through a local D1-shaped SQLite transport. Not hosted proof.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCaseGrantProvisioning } from '../../../src/lib/tenancy/case-grant-provisioning.ts';
import { CASE_ROLES, effective, enables, permits } from '../../../src/lib/tenancy/grants.ts';
import { createManagerBootstrap } from '../../../src/lib/tenancy/provisioning.ts';
import { engine } from '../../../src/lib/tenancy/operations.ts';
import { ALICE, CASE_1, CASE_2, INPUT, ISSUER_A, ISSUER_C, ISSUER_STAFF, STAFF, world } from './world.ts';

describe('trusted non-request case grant provisioning', () => {
  it.each(CASE_ROLES.flatMap((role) => [ALICE, STAFF].map((target) => ({ role, target }))))('creates only the requested $role capability for $target.kind', async ({ role, target }) => {
    const w = await world();
    const made = await w.make().grantCase({ ...INPUT, target, role });
    expect(made).toMatchObject({ kind: 'applied', repeated: false, grant: { clientId: 'client-a', role, scope: { kind: 'case', caseId: CASE_1 }, state: 'active', version: 2, createdBy: { issuer: 'control-plane:client-a', subject: INPUT.operator } } });
    const held = await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: target, scope: { kind: 'case', caseId: CASE_1 } });
    expect(held).toHaveLength(1);
    const grant = held[0]!;
    expect(effective(grant, { clientId: w.deployment.clientId, principal: target, scope: { kind: 'case', caseId: CASE_1 }, now: w.now() })).toBe(true);
    expect(permits(grant.role, 'read')).toBe(role === 'viewer' || role === 'editor');
    expect(permits(grant.role, 'write-user-work')).toBe(role === 'editor');
    expect(enables(grant.role, 'operate')).toBe(role === 'operator');
    expect(enables(grant.role, 'publish')).toBe(role === 'publisher');
    expect(await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: target, scope: { kind: 'client' } })).toEqual([]);
    expect(await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: target, scope: { kind: 'case', caseId: CASE_2 } })).toEqual([]);
    const event = await w.audit.find(`grant-op:${INPUT.operationId}`);
    expect(event).toEqual({ eventId: `grant-op:${INPUT.operationId}`, actor: { kind: 'system', component: 'provisioning', operator: INPUT.operator }, action: 'grant.provision', object: { kind: 'case-grant', id: grant.grantId, caseId: CASE_1 }, version: null, outcome: 'succeeded', at: w.now().toISOString() });
    expect(w.operationRows()).toMatchObject([{ operation: 'create', actor_kind: 'control-plane', actor_issuer: 'control-plane:client-a', actor_subject: INPUT.operator, state: 'audited' }]);
  });

  it('is a creation-only authority with no management or upload method and no tenancy barrel export', async () => {
    const w = await world();
    expect(Object.keys(w.make())).toEqual(['grantCase']);
    const index = readFileSync(new URL('../../../src/lib/tenancy/index.ts', import.meta.url), 'utf8');
    expect(index).not.toContain('case-grant-provisioning');
  });

  it('ignores requester-shaped extras rather than recording a forged verified actor', async () => {
    const w = await world();
    await w.make().grantCase({ ...INPUT, actor: { kind: 'verified', principal: STAFF, sessionId: 'invented' }, principal: STAFF, sessionId: 'invented' } as never);
    const event = await w.audit.find(`grant-op:${INPUT.operationId}`);
    expect(event!.actor).toEqual({ kind: 'system', component: 'provisioning', operator: INPUT.operator });
    expect(Object.keys(event!.actor).sort()).toEqual(['component', 'kind', 'operator']);
  });

  it.each([
    { operator: '' }, { operator: 'staff user' }, { operator: 'x'.repeat(129) }, { operator: 'run-1\n' },
    { operationId: '' }, { operationId: 'bad op' }, { operationId: 'x'.repeat(120) }, { operationId: 'op-1\n' },
    { target: null }, { target: { ...ALICE, subject: '' } }, { target: { ...ALICE, subject: 2 } }, { target: { ...ALICE, subject: 'x'.repeat(129) } }, { target: { ...ALICE, subject: 'user_alice\n' } },
    { target: { ...ALICE, issuer: ISSUER_C } }, { target: { ...ALICE, issuer: `${ISSUER_A}/` } },
    { target: { ...ALICE, issuer: ISSUER_A.toUpperCase() } }, { target: { ...ALICE, issuer: `${ISSUER_A}:443` } },
    { target: { ...STAFF, issuer: ISSUER_A } }, { target: { ...ALICE, issuer: ISSUER_STAFF } },
    { target: { ...ALICE, kind: 'system' } }, { target: { ...ALICE, kind: undefined } }, { target: { ...STAFF, issuer: 'control-plane:client-a' } },
    { role: 'grant-admin' }, { role: 'owner' }, { role: 'case.upload-originals' }, { role: null },
    { caseId: null }, { caseId: '' }, { caseId: 'case:1' }, { caseId: '../case-1' }, { caseId: 'x'.repeat(129) }, { caseId: 'unknown-case' },
    { expiresAt: undefined }, { expiresAt: 0 }, { expiresAt: 'tomorrow' }, { expiresAt: '2026-10-26T00:00:00Z' },
    { expiresAt: '2026-10-25T10:00:00.000Z' }, { expiresAt: '2026-10-24T10:00:00.000Z' },
  ])('rejects invalid or foreign input before any write: %j', async (over) => {
    const w = await world();
    expect(await w.make().grantCase({ ...INPUT, ...over } as never)).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
    expect(w.grantRows()).toEqual([]);
    expect(w.operationRows()).toEqual([]);
    expect(w.auditRows()).toEqual([]);
  });

  it.each([null, undefined, {}])('rejects a missing input rather than creating a default grant: %j', async (input) => {
    const w = await world();
    expect(await w.make().grantCase(input as never)).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('refuses a bad identifier factory before writing a permanently unauditable grant', async () => {
    const w = await world();
    await expect(w.make({ newGrantId: () => 'bad grant id' }).grantCase(INPUT)).rejects.toThrow(TypeError);
    expect(w.writes()).toEqual([]);
  });

  it('accepts the longest operation id whose prefixed event fits the audit schema', async () => {
    const w = await world();
    expect(await w.make().grantCase({ ...INPUT, operationId: 'x'.repeat(119) })).toMatchObject({ kind: 'applied' });
  });

  it('refuses a foreign-only case, even for shared staff, without touching either database', async () => {
    const a = await world(), c = await world('c');
    expect(await c.make().grantCase({ ...INPUT, caseId: CASE_2, target: STAFF })).toMatchObject({ kind: 'applied' });
    a.sqlite.prepare('DELETE FROM rs_case WHERE case_id = ?').run(CASE_2);
    expect(await a.make().grantCase({ ...INPUT, caseId: CASE_2, target: STAFF })).toEqual({ kind: 'invalid', reason: 'unknown case' });
    expect(a.writes()).toEqual([]);
    expect(a.grantRows()).toEqual([]);
    expect(c.grantRows()).toHaveLength(1);
    expect(c.auditRows()).toHaveLength(1);
  });

  it.each(['unbound', 'foreign-client', 'foreign-layout'])('rejects a case row in an %s database', async (mode) => {
    const w = await world();
    if (mode === 'unbound') w.sqlite.exec('DELETE FROM rs_storage_identity');
    else if (mode === 'foreign-client') w.sqlite.exec("UPDATE rs_storage_identity SET client_id = 'client-c'");
    else w.sqlite.exec("UPDATE rs_storage_identity SET layout = 'unknown/2'");
    expect(await w.make().grantCase(INPUT)).toEqual({ kind: 'invalid', reason: 'unknown case' });
    expect(w.writes()).toEqual([]);
    expect(w.grantRows()).toEqual([]);
    expect(w.auditRows()).toEqual([]);
  });

  it('requires a case directory and an append-plus-find provisioning audit port', async () => {
    const w = await world();
    expect(() => createCaseGrantProvisioning({ ...w.options, cases: undefined as never })).toThrow(TypeError);
    expect(() => w.make({ audit: { append: w.audit.append } as never })).toThrow(TypeError);
  });

  it('uses the same immutable input snapshot for checking, operation binding, audit and insertion', async () => {
    const w = await world(), target = { ...ALICE, subject: String(ALICE.subject) };
    const input = { ...INPUT, target };
    const pending = w.make().grantCase(input);
    target.subject = 'user_other';
    expect(await pending).toMatchObject({ kind: 'applied', grant: { subject: ALICE.subject } });
    expect(w.operationRows()).toMatchObject([{ request: JSON.stringify(['case-provision', ALICE.issuer, ALICE.subject, ALICE.kind, 'viewer', CASE_1, null]) }]);
  });
});

describe('pending, exact audit acknowledgement and durable retry', () => {
  it('persists pending plus its fixed event, grants nothing on audit failure, and resumes after process-like restart', async () => {
    const w = await world();
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    const pending = await w.make().grantCase(INPUT);
    expect(pending).toMatchObject({ kind: 'audit-pending', retryable: true });
    const op = await w.grants.operationOf({ clientId: w.deployment.clientId, operationId: INPUT.operationId });
    expect(op).toMatchObject({ state: 'recorded' });
    expect(w.grantRows()).toMatchObject([{ state: 'pending', version: 1 }]);
    const grant = (await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: ALICE, scope: { kind: 'case', caseId: CASE_1 } }))[0]!;
    expect(effective(grant, { clientId: w.deployment.clientId, principal: ALICE, scope: grant.scope, now: w.now() })).toBe(false);
    expect(w.auditRows()).toEqual([]);
    w.hooks.failSql = null; w.advance(60_000);
    expect(await w.restart().grantCase(INPUT)).toMatchObject({ kind: 'applied', repeated: true, grant: { grantId: grant.grantId, state: 'active' } });
    expect(await w.grants.operationOf({ clientId: w.deployment.clientId, operationId: INPUT.operationId })).toEqual({ ...op, state: 'audited' });
    expect(await w.audit.find(`grant-op:${INPUT.operationId}`)).toEqual(JSON.parse(op!.event));
    expect(w.auditRows()).toHaveLength(1);
    const writes = w.writes().length;
    expect(await w.restart().grantCase(INPUT)).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.writes()).toHaveLength(writes);
  });

  it.each([false, true])('recovers a persisted audit event after a lost append acknowledgement (unreadable=%s)', async (unreadable) => {
    const w = await world();
    w.hooks.loseAuditAppendAck = true;
    w.hooks.hideAuditAfterCommit = unreadable;
    const result = await w.make().grantCase(INPUT);
    expect(result.kind).toBe(unreadable ? 'audit-pending' : 'applied');
    expect(w.auditRows()).toHaveLength(1);
    w.hooks.loseAuditAppendAck = false; w.hooks.hideAuditAfterCommit = false;
    const appends = w.hooks.sql.filter((s) => /INSERT INTO native_audit_events/.test(s)).length;
    expect(await w.restart().grantCase(INPUT)).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.hooks.sql.filter((s) => /INSERT INTO native_audit_events/.test(s))).toHaveLength(appends);
    expect(w.auditRows()).toHaveLength(1);
  });

  it('refuses a different canonical event under the stable id and leaves the grant pending', async () => {
    const w = await world();
    await w.audit.append({ eventId: `grant-op:${INPUT.operationId}`, actor: { kind: 'system', component: 'provisioning', operator: INPUT.operator }, action: 'grant.unrelated', object: { kind: 'case-grant', id: 'different-grant', caseId: CASE_1 }, version: null, outcome: 'succeeded', at: w.now().toISOString() });
    expect(await w.make().grantCase(INPUT)).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(w.grantRows()).toMatchObject([{ state: 'pending' }]);
    expect(w.operationRows()).toMatchObject([{ state: 'recorded' }]);
    expect(w.auditRows()).toHaveLength(1);
  });

  it('refuses a tampered recorded event before any audit append or activation', async () => {
    const w = await world();
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    await w.make().grantCase(INPUT);
    w.sqlite.exec("UPDATE tenant_grant_operations SET event_json = replace(event_json, 'alpha-seed-1', 'intruder')");
    w.hooks.failSql = null;
    expect(await w.make().grantCase(INPUT)).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(w.grantRows()).toMatchObject([{ state: 'pending' }]);
    expect(w.auditRows()).toEqual([]);
  });

  it.each(["UPDATE tenant_case_grants SET state = 'active'", "UPDATE tenant_grant_operations SET state = 'audited'"])('resumes interruption at %s without another grant or event', async (sql) => {
    const w = await world();
    w.hooks.failSql = new RegExp(sql);
    await expect(w.make().grantCase(INPUT)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.auditRows()).toHaveLength(1);
    w.hooks.failSql = null;
    expect(await w.restart().grantCase(INPUT)).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.auditRows()).toHaveLength(1);
    expect(w.grantRows()).toMatchObject([{ state: 'active', version: 2 }]);
    expect(w.operationRows()).toMatchObject([{ state: 'audited' }]);
  });

  it('does not write when the real case directory fails', async () => {
    const w = await world();
    w.hooks.failSql = /SELECT .*rs_storage_identity/;
    await expect(w.make().grantCase(INPUT)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.writes()).toEqual([]);
  });

  it.each([false, true])('retries a grant batch fault with durable acknowledgement lost=%s', async (lost) => {
    const w = await world();
    w.hooks.failGrantBatch = !lost; w.hooks.loseGrantBatchAck = lost;
    await expect(w.make().grantCase(INPUT)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.grantRows()).toHaveLength(lost ? 1 : 0);
    expect(w.operationRows()).toHaveLength(lost ? 1 : 0);
    expect(w.auditRows()).toEqual([]);
    w.hooks.failGrantBatch = false; w.hooks.loseGrantBatchAck = false;
    expect(await w.restart().grantCase(INPUT)).toMatchObject({ kind: 'applied', repeated: lost });
    expect(w.grantRows()).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(1);
  });

  it('settles an exact replay after expiry without extending it or making it effective', async () => {
    const w = await world(), input = { ...INPUT, expiresAt: '2026-10-25T10:00:01.000Z' };
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    expect(await w.make().grantCase(input)).toMatchObject({ kind: 'audit-pending' });
    w.advance(1000); w.hooks.failSql = null;
    const result = await w.restart().grantCase(input);
    expect(result).toMatchObject({ kind: 'applied', repeated: true, grant: { expiresAt: input.expiresAt } });
    if (result.kind !== 'applied') throw new Error('expected applied');
    expect(effective(result.grant, { clientId: w.deployment.clientId, principal: ALICE, scope: result.grant.scope, now: w.now() })).toBe(false);
    expect(await w.make().grantCase({ ...input, operationId: 'fresh-expired' })).toMatchObject({ kind: 'invalid' });
    expect(await w.make().grantCase({ ...input, operationId: 'fresh-future', expiresAt: '2026-10-26T10:00:00.000Z' })).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    expect(w.grantRows()).toHaveLength(1);
  });

  it.each([false, true])('never resurrects a revoked grant on replay (initially pending=%s)', async (pending) => {
    const w = await world();
    if (pending) w.hooks.failSql = /INSERT INTO native_audit_events/;
    await w.make().grantCase(INPUT);
    w.hooks.failSql = null;
    const grant = (await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: ALICE, scope: { kind: 'case', caseId: CASE_1 } }))[0]!;
    // Exercise the real repository/engine's revocation boundary with honest control-plane attribution, not a
    // fabricated manager requester. The new producer itself has no revoke method.
    const e = engine(w.options);
    const operation = await e.record({ operationId: 'external-revocation', operation: 'revoke', actor: { issuer: 'control-plane:client-a', subject: 'revoke-run', kind: 'control-plane' }, identity: { kind: 'system', component: 'provisioning', operator: 'revoke-run' }, action: 'grant.revoke', request: JSON.stringify(['revoke', grant.grantId, grant.version]), grantId: grant.grantId, caseId: CASE_1 });
    const revoked = await w.grants.revoke({ clientId: w.deployment.clientId, grantId: grant.grantId, expectedVersion: grant.version, operation, at: w.now().toISOString() });
    if (!revoked) throw new Error('expected revoked');
    await e.complete({ ...operation, state: 'recorded' }, revoked, false);
    expect(await w.restart().grantCase(INPUT)).toMatchObject(pending ? { kind: 'stale' } : { kind: 'applied', repeated: true, grant: { state: 'revoked' } });
    expect(w.grantRows()).toMatchObject([{ state: 'revoked' }]);
    expect(await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: ALICE, scope: { kind: 'case', caseId: CASE_1 } })).toEqual([]);
  });
});

describe('operation binding and competing writers', () => {
  it.each([
    { operator: 'another-operator' }, { target: { ...ALICE, subject: 'another-user' } }, { target: STAFF },
    { role: 'editor' as const }, { caseId: CASE_2 }, { expiresAt: '2026-10-26T10:00:00.000Z' },
  ])('does not let a reused id change its operator or exact request: %j', async (over) => {
    const w = await world();
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    await w.make().grantCase(INPUT);
    w.hooks.failSql = null;
    expect(await w.restart().grantCase({ ...INPUT, ...over })).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.grantRows()).toMatchObject([{ state: 'pending' }]);
    expect(w.auditRows()).toEqual([]);
  });

  it('does not alias omitted expiry to the recorded null or activate it on a missing case replay', async () => {
    const w = await world();
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    await w.make().grantCase(INPUT);
    w.hooks.failSql = null;
    expect(await w.make().grantCase({ ...INPUT, expiresAt: undefined } as never)).toMatchObject({ kind: 'invalid' });
    w.sqlite.prepare('DELETE FROM rs_case WHERE case_id = ?').run(CASE_1);
    expect(await w.make().grantCase(INPUT)).toEqual({ kind: 'invalid', reason: 'unknown case' });
    expect(w.grantRows()).toMatchObject([{ state: 'pending' }]);
    expect(w.auditRows()).toEqual([]);
  });

  it.each([true, false])('shares operation-id uniqueness with manager bootstrap, case producer first=%s', async (first) => {
    const w = await world(), bootstrap = createManagerBootstrap(w.options);
    const manager = () => bootstrap.grantManager({ operator: INPUT.operator, operationId: INPUT.operationId, target: STAFF, expiresAt: null });
    const grant = () => w.make().grantCase(INPUT);
    expect(await (first ? grant() : manager())).toMatchObject({ kind: 'applied' });
    expect(await (first ? manager() : grant())).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.grantRows()).toHaveLength(1);
    expect(w.operationRows()).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(1);
  });

  it('settles competing identical operations to one grant and one canonical event', async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 6 }, () => w.make().grantCase(INPUT)));
    expect(results.every((r) => r.kind === 'applied')).toBe(true);
    expect(w.grantRows()).toHaveLength(1);
    expect(w.operationRows()).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(1);
    expect(w.operationRows()).toMatchObject([{ state: 'audited' }]);
  });

  it('competing requests reusing one id cannot leave an orphan grant or leak the winner', async () => {
    const w = await world();
    const results = await Promise.all([w.make().grantCase(INPUT), w.make().grantCase({ ...INPUT, target: STAFF })]);
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict')).toEqual([{ kind: 'conflict', reason: 'operation-reused' }]);
    expect(w.grantRows()).toHaveLength(1);
    expect(w.operationRows()).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(1);
  });

  it.each([false, true])('viewer/editor compete for one live slot, even while pending=%s', async (pending) => {
    const w = await world();
    if (pending) w.hooks.failSql = /INSERT INTO native_audit_events/;
    const results = await Promise.all([w.make().grantCase(INPUT), w.make().grantCase({ ...INPUT, operationId: 'competing-editor', role: 'editor' })]);
    expect(results.filter((r) => r.kind === (pending ? 'audit-pending' : 'applied'))).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict')).toEqual([{ kind: 'conflict', reason: 'slot-taken' }]);
    expect(w.grantRows()).toHaveLength(1);
    expect(w.operationRows()).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(pending ? 0 : 1);
  });
});
