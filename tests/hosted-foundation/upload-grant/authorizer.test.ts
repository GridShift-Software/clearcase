// NATIVE24 RED first: the runtime upload authorizer against a REAL distinct case.upload-originals grant. Written before
// any source exists. node:sqlite stand-ins, not D1 provider proof.
import { describe, expect, it } from 'vitest';
import type { AuthorizeUpload } from '../../../src/lib/submissions/ports.ts';
import { createUploadAuthorizer } from '../../../src/lib/tenancy/upload-capability.ts';
import { CASE_1, CASE_2, CLIENT_A, ISSUER_C, SESSION, SESSION_2, client, refusal, staff, world } from './world.ts';

const USER = client('user_a'), STAFF = staff('staff_a');

describe('the upload grant is a distinct, explicit capability', () => {
  it('allows only a principal that holds explicit case access AND an explicit current upload grant, and audits the verified actor', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    expect(await w.issue(USER, CASE_1, 'op-1')).toMatchObject({ kind: 'applied' });
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
    const event = w.events.find((e) => e.action === 'case.upload-originals');
    expect(event).toMatchObject({ outcome: 'succeeded', object: { kind: 'case', id: CASE_1, caseId: CASE_1 }, actor: { kind: 'verified', principal: { issuer: USER.issuer, subject: USER.subject, kind: 'client' }, sessionId: SESSION } });
  });
  it.each(['viewer', 'editor', 'operator', 'publisher'] as const)('a %s case grant alone never implies upload', async (role) => {
    const w = await world();
    w.seedCase(USER, role, CASE_1);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a client-wide grant-admin, staff membership and a staff editor grant imply no upload', async () => {
    const w = await world();
    w.seedCase(USER, 'grant-admin', null);
    w.seedCase(STAFF, 'editor', CASE_1);
    w.seedCase(STAFF, 'operator', CASE_1);
    w.seedCase(STAFF, 'publisher', CASE_1);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    expect((await refusal(w.authorize(w.request(STAFF)))).code).toBe('forbidden');
  });
  it('an upload grant alone reaches no case content: it implies neither read nor any case capability', async () => {
    const w = await world();
    await w.issue(USER, CASE_1, 'op-1');
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    expect((await refusal(w.caseAuthorizer.authorizeCase({ principal: USER, sessionId: SESSION, caseId: CASE_1, operation: 'read' }))).code).toBe('forbidden');
    expect((await refusal(w.caseAuthorizer.authorizeCase({ principal: USER, sessionId: SESSION, caseId: CASE_1, operation: 'read-original' }))).code).toBe('forbidden');
    expect((await refusal(w.caseAuthorizer.authorizeCapability({ principal: USER, sessionId: SESSION, caseId: CASE_1, capability: 'operate' }))).code).toBe('forbidden');
  });
  it('an upload grant does not make a viewer an editor, nor the reverse', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    await w.authorize(w.request(USER));
    expect((await refusal(w.caseAuthorizer.authorizeCase({ principal: USER, sessionId: SESSION, caseId: CASE_1, operation: 'write-user-work' }))).code).toBe('forbidden');
  });
  it('is scoped to the exact case: a grant on one case is nothing on another', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.seedCase(USER, 'viewer', CASE_2);
    await w.issue(USER, CASE_1, 'op-1');
    await expect(w.authorize(w.request(USER, CASE_1))).resolves.toBeUndefined();
    expect((await refusal(w.authorize(w.request(USER, CASE_2)))).code).toBe('forbidden');
  });
  it('is scoped to the exact tuple: a subject, an issuer or a principal kind that differs is not the grantee', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    w.seedCase(client('user_A'), 'viewer', CASE_1);
    w.seedCase(client('user_a '), 'viewer', CASE_1);
    w.seedCase(staff('user_a'), 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    for (const other of [client('user_A'), client('user_a '), staff('user_a')]) expect((await refusal(w.authorize(w.request(other)))).code).toBe('forbidden');
    expect((await refusal(w.authorize(w.request(client('user_a', ISSUER_C))))).code).toBe('wrong-client');
  });
});

describe('uniform refusal', () => {
  it('unknown, ungranted, revoked, expired, pending and never-granted cases refuse identically, naming nothing', async () => {
    const w = await world({ cases: [CASE_1, CASE_2, 'case-3', 'case-4'] });
    for (const c of [CASE_1, CASE_2, 'case-3', 'case-4']) w.seedCase(USER, 'viewer', c);
    w.seedCase(USER, 'viewer', 'case-ghost'); // a case grant for a case that does not exist
    const revoked = await w.issue(USER, CASE_2, 'op-2');
    await w.issue(USER, 'case-3', 'op-3', { expiresAt: '2026-10-25T08:00:01.000Z' });
    w.advance(5_000);
    w.state.auditFails = true;
    await w.issue(USER, 'case-4', 'op-4'); // pending: never acknowledged
    w.state.auditFails = false;
    if (revoked.kind !== 'applied') throw new Error('setup');
    await w.provisioning.revoke({ operator: 'provisioning-run-1', operationId: 'rev-2', grantId: revoked.grant.grantId, expectedVersion: revoked.grant.version });
    const unknown = await w.issue(USER, 'case-ghost', 'op-g'); // refused: no such case, so no grant exists
    expect(unknown).toMatchObject({ kind: 'invalid' });
    const seen = [];
    for (const c of [CASE_1 /* never granted upload */, CASE_2, 'case-3', 'case-4', 'case-ghost', 'case-unlisted']) seen.push(await refusal(w.authorize(w.request(USER, c))));
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(seen[0]).toMatchObject({ code: 'forbidden', retryable: false });
    expect(seen[0].message).not.toMatch(/case-|upload|grant|revoked|expired|pending/i);
  });
  it('a refusal for a principal without case access plants no event in a case audit scope', async () => {
    const w = await world();
    await w.issue(USER, CASE_1, 'op-1');
    await refusal(w.authorize(w.request(USER)));
    const denied = w.events.filter((e) => e.outcome === 'denied');
    expect(denied.every((e) => e.object.caseId === null)).toBe(true);
  });
  it('a revoked grant is gone at once, and a later re-issue is a new grant', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    const first = await w.issue(USER, CASE_1, 'op-1');
    if (first.kind !== 'applied') throw new Error('setup');
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
    expect(await w.provisioning.revoke({ operator: 'provisioning-run-1', operationId: 'rev-1', grantId: first.grant.grantId, expectedVersion: first.grant.version })).toMatchObject({ kind: 'applied' });
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    const second = await w.issue(USER, CASE_1, 'op-2');
    expect(second).toMatchObject({ kind: 'applied' });
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
  });
  it('an expired grant is void', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1', { expiresAt: '2026-10-25T08:10:00.000Z' });
    await expect(w.authorize(w.request(USER))).resolves.toBeUndefined();
    w.advance(10 * 60_000);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a lost case access beats a standing upload grant', async () => {
    const w = await world();
    const seeded = w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    w.db.prepare("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2026-10-25T08:00:00.000Z' WHERE grant_id = ?").run(seeded);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a case that no longer exists refuses even with both grants', async () => {
    const w = await world({ cases: [CASE_2] });
    w.seedCase(USER, 'viewer', CASE_1);
    w.db.prepare("INSERT INTO tenant_upload_grants (grant_id, client_id, case_id, issuer, subject, principal_kind, state, version, created_operation_id, request, created_at) VALUES ('x', 'client-a', ?, ?, ?, 'client', 'pending', 1, 'x-op', '[]', '2026-10-25T08:00:00.000Z')").run(CASE_1, USER.issuer, USER.subject);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
});

describe('identity and session', () => {
  it('a revoked session is 401 invalid-session, before any case information, even for a principal with no grant', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    w.revoked.add(SESSION);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('invalid-session');
    expect((await refusal(w.authorize(w.request(client('nobody'), CASE_2, SESSION_2)))).code).toBe('forbidden'); // a different, live session
    w.revoked.add(SESSION_2);
    expect((await refusal(w.authorize(w.request(client('nobody'), 'case-ghost', SESSION_2)))).code).toBe('invalid-session');
  });
  it('a session check that fails is a retryable 503, never an allow', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    w.state.sessionFails = true;
    expect(await refusal(w.authorize(w.request(USER)))).toMatchObject({ code: 'identity-unavailable', retryable: true });
  });
  it('anonymous and malformed identities are unauthenticated', async () => {
    const w = await world();
    for (const bad of [{ ...w.request(USER), principal: null }, { ...w.request(USER), sessionId: null }, { ...w.request(USER), principal: { ...USER, subject: '' } }, null, undefined]) {
      expect((await refusal(w.authorize(bad as never))).code).toBe('unauthenticated');
    }
  });
  it('a foreign deployment client, a foreign issuer and a forged control-plane principal are wrong-client', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    expect((await refusal(w.authorize({ ...w.request(USER), clientId: 'client-c' as typeof CLIENT_A }))).code).toBe('wrong-client');
    expect((await refusal(w.authorize(w.request(client('user_a', ISSUER_C))))).code).toBe('wrong-client');
    expect((await refusal(w.authorize(w.request({ issuer: 'control-plane:client-a', subject: 'provisioning-run-1', kind: 'staff' })))).code).toBe('wrong-client');
    expect((await refusal(w.authorize(w.request({ issuer: 'control-plane:client-a', subject: 'provisioning-run-1', kind: 'control-plane' } as never)))).code).toBe('wrong-client');
  });
});

describe('faults and configuration', () => {
  it.each([['grantsFail'], ['uploadsFail'], ['casesFail']] as const)('%s is a retryable identity-unavailable, never an allow and never a 403', async (flag) => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    w.state[flag] = true;
    expect(await refusal(w.authorize(w.request(USER)))).toMatchObject({ code: 'identity-unavailable', retryable: true });
  });
  it('an unavailable audit log refuses the upload (audit-unavailable) and the denial stands when its event cannot persist', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'op-1');
    w.state.requestAuditFails = true;
    expect(await refusal(w.authorize(w.request(USER)))).toMatchObject({ code: 'audit-unavailable', retryable: true });
    expect((await refusal(w.authorize(w.request(USER, CASE_2)))).code).toBe('forbidden');
  });
  it('null configuration is a null authorizer (the intake answers 503); a half-configured one refuses to construct', async () => {
    const w = await world();
    expect(createUploadAuthorizer(null)).toBeNull();
    expect(createUploadAuthorizer(undefined as never)).toBeNull();
    const full = { deployment: w.deployment, grants: { grantsOf: async () => [] }, uploads: { heldBy: async () => [] }, cases: { exists: async () => true }, session: async () => undefined, audit: w.requestAudit, now: () => new Date() };
    expect(typeof createUploadAuthorizer(full)).toBe('function');
    for (const key of Object.keys(full)) expect(() => createUploadAuthorizer({ ...full, [key]: undefined } as never)).toThrow(TypeError);
  });
  it('is structurally the intake port, so the composition cannot widen it', async () => {
    const w = await world();
    const port: AuthorizeUpload = w.authorize;
    expect(typeof port).toBe('function');
    expect(CASE_1).toBeTruthy();
  });
});
