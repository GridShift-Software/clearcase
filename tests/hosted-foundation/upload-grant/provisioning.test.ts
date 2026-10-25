// NATIVE24 RED first: trusted, non-request provisioning of the case.upload-originals grant. Written before any source
// exists. node:sqlite stand-ins and an in-memory audit double, not D1 or audit-log provider proof.
import { describe, expect, it } from 'vitest';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { createGrantManagement } from '../../../src/lib/tenancy/management.ts';
import { createUploadProvisioning } from '../../../src/lib/tenancy/upload-provisioning.ts';
import { CASE_1, CASE_2, OPERATOR, SESSION, TUPLE, client, refusal, staff, world } from './world.ts';

const USER = client('user_a'), STAFF = staff('staff_a');
const revoke = (w: Awaited<ReturnType<typeof world>>, grantId: string, version: number, operationId = 'rev-1', operator = OPERATOR) => w.provisioning.revoke({ operator, operationId, grantId, expectedVersion: version });

describe('issuing', () => {
  it('stores the grant pending, confirms its audit event, then activates it, and records an honest system actor', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    const r = await w.issue(USER, CASE_1, 'op-1');
    expect(r).toMatchObject({ kind: 'applied', repeated: false, grant: { state: 'active', version: 2, caseId: CASE_1, issuer: USER.issuer, subject: USER.subject, principalKind: 'client' } });
    expect(w.events).toHaveLength(1);
    const e = w.events[0];
    expect(e).toMatchObject({ eventId: 'upload-grant-op:op-1', action: 'grant.upload.issue', outcome: 'succeeded', object: { kind: 'upload-grant', caseId: CASE_1 } });
    expect(e.actor).toEqual({ kind: 'system', component: 'provisioning', operator: OPERATOR });
    expect(w.ledger()).toEqual([{ operation_id: 'op-1', operation: 'issue', state: 'audited', actor_kind: 'control-plane', actor_subject: OPERATOR }]);
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
  });
  it('grants nothing while the audit event is unconfirmed; a retry by the same operator completes it', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.state.auditFails = true;
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'audit-pending', retryable: true });
    expect(w.rows()).toMatchObject([{ state: 'pending' }]);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    w.state.auditFails = false;
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active' } });
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
    expect(w.events).toHaveLength(1);
  });
  it('treats a lost acknowledgement as persisted only because find returns the byte-identical event, and never appends twice', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.state.lostAck = true;
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied' });
    expect(w.events).toHaveLength(1);
    expect(w.state.appends).toBe(1);
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied', repeated: true });
    expect(w.state.appends).toBe(1);
  });
  it('a lost acknowledgement with the lookup also down is pending, not success', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.state.lostAck = true; w.state.findFails = true;
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'audit-pending' });
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a different event under the same id is audit-mismatch and the grant stays pending', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.events.push({ eventId: 'upload-grant-op:op-1', actor: { kind: 'system', component: 'provisioning', operator: 'someone-else' }, action: 'grant.upload.issue', object: { kind: 'upload-grant', id: 'other', caseId: CASE_1 }, version: null, outcome: 'succeeded', at: '2026-10-25T07:00:00.000Z' });
    expect(await w.issue(USER, CASE_1, 'op-1')).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(w.rows()).toMatchObject([{ state: 'pending' }]);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('an acknowledged but non-matching find (the log answers another actor) is never counted as confirmation', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    const real = w.audit.find;
    w.audit.find = async (id) => { const f = await real(id); return f ? { ...f, actor: { ...f.actor, operator: 'tampered' } } : f; };
    w.state.lostAck = true;
    expect(await w.issue(USER, CASE_1, 'op-1')).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    expect(w.rows()).toMatchObject([{ state: 'pending' }]);
  });
  it('is idempotent on its operation id and refuses the id for another request or another operator', async () => {
    const w = await world();
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied', repeated: false });
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied', repeated: true });
    expect(await w.issue(USER, CASE_2, 'op-1')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await w.issue(STAFF, CASE_1, 'op-1')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await w.issue(USER, CASE_1, 'op-1', { operator: 'another-run' })).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.rows()).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });
  it('one live grant per exact tuple: a second is slot-taken, and a revoked one frees the slot', async () => {
    const w = await world();
    const a = await w.issue(USER, CASE_1, 'op-1');
    expect(await w.issue(USER, CASE_1, 'op-2')).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    expect(await w.issue(USER, CASE_2, 'op-3')).toMatchObject({ kind: 'applied' }); // another case
    expect(await w.issue(STAFF, CASE_1, 'op-4')).toMatchObject({ kind: 'applied' }); // another principal
    if (a.kind !== 'applied') throw new Error('setup');
    await revoke(w, a.grant.grantId, a.grant.version);
    expect(await w.issue(USER, CASE_1, 'op-5')).toMatchObject({ kind: 'applied' });
  });
  it('competing issuers for one tuple: exactly one wins and the loser is slot-taken', async () => {
    const w = await world();
    const results = await Promise.all([w.issue(USER, CASE_1, 'race-1'), w.issue(USER, CASE_1, 'race-2'), w.issue(USER, CASE_1, 'race-3')]);
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict' && r.reason === 'slot-taken')).toHaveLength(2);
    expect(w.rows().filter((r) => r.state !== 'revoked')).toHaveLength(1);
  });
  it('replaying one operation concurrently settles to one grant and one audit event', async () => {
    const w = await world();
    const results = await Promise.all([w.issue(USER, CASE_1, 'same'), w.issue(USER, CASE_1, 'same'), w.issue(USER, CASE_1, 'same')]);
    expect(results.every((r) => r.kind === 'applied')).toBe(true);
    expect(w.rows()).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });
  it('refuses what is not a principal of this client or of staff, including a forged control-plane principal', async () => {
    const w = await world();
    const bad = [
      { issuer: 'https://client-c.example.test', subject: 'x', kind: 'client' }, // another client's issuer
      { issuer: USER.issuer, subject: 'x', kind: 'staff' }, // client issuer under the staff kind
      { issuer: STAFF.issuer, subject: 'x', kind: 'client' },
      { issuer: 'control-plane:client-a', subject: OPERATOR, kind: 'staff' },
      { issuer: 'control-plane:client-a', subject: OPERATOR, kind: 'control-plane' },
      { issuer: USER.issuer, subject: '', kind: 'client' },
      { issuer: USER.issuer, subject: 7, kind: 'client' },
      null,
    ];
    for (const target of bad) expect(await w.provisioning.grant({ operator: OPERATOR, operationId: `bad-${Math.random()}`, target: target as never, caseId: CASE_1, expiresAt: null })).toMatchObject({ kind: 'invalid' });
    expect(w.rows()).toHaveLength(0);
    expect(w.events).toHaveLength(0);
  });
  it('validates the case, the expiry, the operator and the operation id', async () => {
    const w = await world();
    const base = { operator: OPERATOR, operationId: 'op-1', target: TUPLE(USER), caseId: CASE_1, expiresAt: null };
    expect(await w.provisioning.grant({ ...base, caseId: 'case-ghost' as never })).toMatchObject({ kind: 'invalid', reason: 'unknown case' });
    expect(await w.provisioning.grant({ ...base, caseId: null as never })).toMatchObject({ kind: 'invalid' });
    expect(await w.provisioning.grant({ ...base, caseId: '../x' as never })).toMatchObject({ kind: 'invalid' });
    expect(await w.provisioning.grant({ ...base, expiresAt: '2026-10-25T07:00:00.000Z' })).toMatchObject({ kind: 'invalid' });
    expect(await w.provisioning.grant({ ...base, expiresAt: 'tomorrow' })).toMatchObject({ kind: 'invalid' });
    expect(await w.provisioning.grant({ ...base, operator: '' })).toMatchObject({ kind: 'invalid' });
    expect(await w.provisioning.grant({ ...base, operationId: 'a b' })).toMatchObject({ kind: 'invalid' });
    expect(w.rows()).toHaveLength(0);
  });
  it('a case lookup fault is storage-unavailable, never a created grant', async () => {
    const w = await world();
    w.state.casesFail = true;
    expect((await refusal(w.issue(USER, CASE_1, 'op-1'))).code).toBe('storage-unavailable');
    expect(w.rows()).toHaveLength(0);
  });
  it('a batch fault surfaces as a retryable storage fault, not a lost race', async () => {
    const w = await world();
    w.state.batchFails = true;
    expect(await refusal(w.issue(USER, CASE_1, 'op-1'))).toMatchObject({ code: 'storage-unavailable', retryable: true });
    w.state.batchFails = false;
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied' });
  });
});

describe('revoking', () => {
  it('takes effect before its audit event is confirmed, and a retry completes the event', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    const a = await w.issue(USER, CASE_1, 'op-1');
    if (a.kind !== 'applied') throw new Error('setup');
    w.state.auditFails = true;
    expect(await revoke(w, a.grant.grantId, a.grant.version)).toMatchObject({ kind: 'audit-pending' });
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    w.state.auditFails = false;
    expect(await revoke(w, a.grant.grantId, a.grant.version)).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'revoked' } });
    expect(w.events.filter((e) => e.action === 'grant.upload.revoke')).toHaveLength(1);
  });
  it('is compare-and-set: a stale version loses, an unknown grant is gone, and a concurrent pair has one winner', async () => {
    const w = await world();
    const a = await w.issue(USER, CASE_1, 'op-1');
    if (a.kind !== 'applied') throw new Error('setup');
    expect(await revoke(w, a.grant.grantId, a.grant.version + 5, 'rev-stale')).toEqual({ kind: 'stale' });
    expect(await revoke(w, 'no-such-grant', 1, 'rev-gone')).toEqual({ kind: 'gone' });
    const both = await Promise.all([revoke(w, a.grant.grantId, a.grant.version, 'rev-a'), revoke(w, a.grant.grantId, a.grant.version, 'rev-b')]);
    expect(both.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(both.filter((r) => r.kind === 'stale')).toHaveLength(1);
    expect(await revoke(w, a.grant.grantId, a.grant.version, 'rev-c')).toEqual({ kind: 'stale' }); // already revoked
  });
  it('a revoked pending grant never activates, even when its event is later confirmed', async () => {
    const w = await world();
    w.state.auditFails = true;
    const pending = await w.issue(USER, CASE_1, 'op-1');
    expect(pending).toMatchObject({ kind: 'audit-pending' });
    const grantId = (pending as { grantId: string }).grantId;
    w.state.auditFails = false;
    expect(await revoke(w, grantId, 1)).toMatchObject({ kind: 'applied', grant: { state: 'revoked' } });
    expect(await w.issue(USER, CASE_1, 'op-1')).toEqual({ kind: 'stale' });
    expect(w.rows()).toMatchObject([{ state: 'revoked' }]);
  });
  it('the operation ledger binds a revoke id to its operator, type and request', async () => {
    const w = await world();
    const a = await w.issue(USER, CASE_1, 'op-1');
    const b = await w.issue(STAFF, CASE_1, 'op-2');
    if (a.kind !== 'applied' || b.kind !== 'applied') throw new Error('setup');
    expect(await revoke(w, a.grant.grantId, a.grant.version, 'rev-1')).toMatchObject({ kind: 'applied' });
    expect(await revoke(w, b.grant.grantId, b.grant.version, 'rev-1')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await revoke(w, a.grant.grantId, a.grant.version, 'op-1')).toEqual({ kind: 'conflict', reason: 'operation-reused' }); // an issue id is no revoke id
    expect(await revoke(w, a.grant.grantId, a.grant.version, 'rev-1', 'another-run')).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.rows().find((r) => r.grant_id === b.grant.grantId)?.state).toBe('active');
  });
});

describe('no request authority', () => {
  it('requires an audit port with append and find', async () => {
    const w = await world();
    const base = { deployment: w.deployment, db: w.handle, cases: { exists: async () => true }, now: () => new Date() };
    expect(() => createUploadProvisioning({ ...base, audit: { append: async () => ({ eventId: 'x' }) } } as never)).toThrow(TypeError);
    expect(() => createUploadProvisioning({ ...base, audit: undefined } as never)).toThrow(TypeError);
    expect(() => createUploadProvisioning({ ...base, db: undefined, audit: w.audit } as never)).toThrow(TypeError);
  });
  it('writes only system-actor events: a verified request port or sink cannot stand in for the provisioning port', async () => {
    const w = await world();
    const verified = createUploadProvisioning({ deployment: w.deployment, db: w.handle, cases: { exists: async () => true }, now: () => new Date('2026-10-25T08:00:00.000Z'), audit: { append: w.requestAudit.append, find: w.audit.find } as never });
    const r = await verified.grant({ operator: OPERATOR, operationId: 'op-1', target: TUPLE(USER), caseId: CASE_1, expiresAt: null });
    expect(r.kind).not.toBe('applied');
    expect(w.rows().every((x) => x.state !== 'active')).toBe(true);
    expect(w.events).toHaveLength(0);
  });
  it('the 114 management cannot issue it: a grant-admin naming an upload role gets no grant, and the 114 table has no upload role', async () => {
    const w = await world();
    const admin = staff('admin');
    w.seedCase(admin, 'grant-admin', null);
    const manage = createGrantManagement({ deployment: w.deployment, grants: d1GrantRepository(w.handle), cases: { exists: async () => true }, audit: { append: w.requestAudit.append, find: w.audit.find }, now: () => new Date('2026-10-25T08:00:00.000Z') });
    for (const role of ['uploader', 'upload-originals', 'case.upload-originals']) {
      expect(await manage.create({ actor: { principal: admin, sessionId: SESSION }, operationId: `m-${role}`, target: TUPLE(USER), role: role as never, caseId: CASE_1, expiresAt: null })).toMatchObject({ kind: 'invalid' });
    }
    expect(w.rows()).toHaveLength(0);
    expect((w.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tenant_case_grants'").get() as { sql: string }).sql).not.toMatch(/upload/i);
  });
});
