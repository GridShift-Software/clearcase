import { describe, expect, it } from 'vitest';
import type { CaseOperation } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { CASE_1, CASE_2, ISSUER_A, ISSUER_C, ISSUER_STAFF, SESSION, client, staff, world } from './world.ts';

const ALL: CaseOperation[] = ['read', 'read-original', 'read-preview', 'write-user-work'];
const call = (w: ReturnType<typeof world>, principal: ReturnType<typeof client>, operation: CaseOperation, caseId = CASE_1) => w.authorizeCase({ principal, sessionId: SESSION, caseId, operation });
const outcome = (p: Promise<void>) => p.then(() => 'allowed', (e: { code?: string }) => e.code ?? 'thrown');

describe('authorizeCase: roles', () => {
  it('a viewer reads, opens originals and previews, and does not write user work', async () => {
    const w = world(), v = client('user_v');
    w.seed(v, 'viewer', CASE_1);
    expect(await Promise.all(ALL.map((op) => outcome(call(w, v, op))))).toEqual(['allowed', 'allowed', 'allowed', 'forbidden']);
  });
  it('an editor also writes user work', async () => {
    const w = world(), e = client('user_e');
    w.seed(e, 'editor', CASE_1);
    expect(await Promise.all(ALL.map((op) => outcome(call(w, e, op))))).toEqual(['allowed', 'allowed', 'allowed', 'allowed']);
  });
  it('operator and publisher are separate capabilities that reach no content by themselves', async () => {
    const w = world(), op = staff('staff_op'), pub = client('user_pub'), v = client('user_v');
    w.seed(op, 'operator', CASE_1); w.seed(pub, 'publisher', CASE_1); w.seed(v, 'viewer', CASE_1);
    for (const p of [op, pub]) expect(await Promise.all(ALL.map((o) => outcome(call(w, p, o))))).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden']);
    const cap = (p: typeof op, capability: 'operate' | 'publish') => outcome(w.authorizeCapability({ principal: p, sessionId: SESSION, caseId: CASE_1, capability }));
    expect([await cap(op, 'operate'), await cap(op, 'publish'), await cap(pub, 'publish'), await cap(pub, 'operate'), await cap(v, 'operate'), await cap(v, 'publish')])
      .toEqual(['allowed', 'forbidden', 'allowed', 'forbidden', 'forbidden', 'forbidden']);
  });
  it('a firm admin, the Global Admin and staff membership reach no case without a case grant', async () => {
    const w = world(), firmAdmin = client('user_admin'), ga = staff('staff_ga'), member = staff('staff_member');
    w.seed(firmAdmin, 'grant-admin', null); w.seed(ga, 'grant-admin', null);
    for (const p of [firmAdmin, ga, member]) for (const op of ALL) expect(await outcome(call(w, p, op))).toBe('forbidden');
  });
  it('a grant reaches only its own case, and an unpublished case is reachable through it', async () => {
    const w = world(), v = client('user_v');
    w.seed(v, 'viewer', CASE_2); // case-2 has no publication: grants do not depend on one
    expect(await outcome(call(w, v, 'read', CASE_2))).toBe('allowed');
    expect(await outcome(call(w, v, 'read', CASE_1))).toBe('forbidden');
  });
});

describe('authorizeCase: explicit staff access', () => {
  it('a staff case grant works and every access appends an event with the verified actor', async () => {
    const w = world(), op = staff('staff_op');
    w.seed(op, 'viewer', CASE_1);
    expect(await outcome(call(w, op, 'read-original'))).toBe('allowed');
    expect(w.events).toMatchObject([{ action: 'case.read-original', outcome: 'succeeded', object: { kind: 'case', id: 'case-1', caseId: 'case-1' }, actor: { kind: 'verified', principal: op, sessionId: SESSION } }]);
  });
  it('staff access fails closed when its audit event cannot persist', async () => {
    const w = world(), op = staff('staff_op');
    w.seed(op, 'viewer', CASE_1);
    w.state.auditFails = true;
    await expect(call(w, op, 'read')).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
  });
  it('a client denial stands, and is recorded, whether or not the audit append works', async () => {
    const w = world(), v = client('user_v');
    expect(await outcome(call(w, v, 'read'))).toBe('forbidden');
    expect(w.events).toMatchObject([{ action: 'case.read', outcome: 'denied', object: { id: 'case-1' } }]);
    w.state.auditFails = true;
    expect(await outcome(call(w, v, 'read'))).toBe('forbidden');
  });
});

describe('authorizeCase: fail closed', () => {
  it('refuses missing principal or session as unauthenticated', async () => {
    const w = world();
    for (const a of [{ principal: null, sessionId: SESSION }, { principal: client('u'), sessionId: null }]) {
      await expect(w.authorizeCase({ ...a, caseId: CASE_1, operation: 'read' } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
    }
  });
  it('refuses another client issuer, an unknown issuer and a kind/issuer mismatch as wrong-client', async () => {
    const w = world();
    w.seed(client('user_v'), 'viewer', CASE_1);
    for (const p of [client('user_v', ISSUER_C), client('user_v', 'https://evil.example.test'), staff('user_v', ISSUER_A), client('user_v', ISSUER_STAFF)]) {
      expect(await outcome(call(w, p, 'read'))).toBe('wrong-client');
    }
  });
  it('a grant written for a client principal does not serve a staff principal of the same subject, nor the reverse', async () => {
    const w = world();
    w.db.prepare("INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at) VALUES ('x', 'client-a', 'case', 'case-1', ?, 'same', 'client', 'viewer', 'content', 'active', 1, 'op-x', '[]', 's', 's', 't')").run(ISSUER_STAFF);
    expect(await outcome(call(w, staff('same'), 'read'))).toBe('forbidden');
  });
  it('refuses expired, revoked and pending grants', async () => {
    const w = world(), e = client('user_exp'), r = client('user_rev'), p = client('user_pend');
    w.seed(e, 'editor', CASE_1, { expiresAt: '2026-10-24T13:00:00.000Z' });
    w.seed(r, 'editor', CASE_1, { state: 'revoked' });
    w.seed(p, 'editor', CASE_1, { state: 'pending' });
    expect(await outcome(call(w, e, 'read'))).toBe('allowed');
    w.advance(3_600_000);
    expect(await outcome(call(w, e, 'read'))).toBe('forbidden');
    expect(await outcome(call(w, r, 'read'))).toBe('forbidden');
    expect(await outcome(call(w, p, 'read'))).toBe('forbidden');
  });
  it('a row of another client in the same table never answers', async () => {
    const w = world(), v = client('user_v');
    w.seed(v, 'editor', CASE_1, { clientId: 'client-c' });
    expect(await outcome(call(w, v, 'read'))).toBe('forbidden');
  });
  it('a grant for an unknown case refuses exactly like no grant, revealing nothing about the case', async () => {
    const w = world(), v = client('user_v'), ghost = id('case', 'case-ghost');
    w.seed(v, 'viewer', 'case-ghost');
    const withGrant = await call(w, v, 'read', ghost).catch((e: Error & { code: string; retryable: boolean }) => ({ code: e.code, retryable: e.retryable, message: e.message }));
    const without = await call(w, client('user_none'), 'read', id('case', 'case-other')).catch((e: Error & { code: string; retryable: boolean }) => ({ code: e.code, retryable: e.retryable, message: e.message }));
    expect(withGrant).toEqual(without);
    expect(withGrant).toEqual({ code: 'forbidden', retryable: false, message: 'forbidden' });
  });
  it('a grant or case lookup failure is identity-unavailable, never an allow', async () => {
    const w = world(), v = client('user_v');
    w.seed(v, 'viewer', CASE_1);
    w.state.grantsFail = true;
    await expect(call(w, v, 'read')).rejects.toMatchObject({ code: 'identity-unavailable', retryable: true });
    w.state.grantsFail = false; w.state.casesFail = true;
    await expect(call(w, v, 'read')).rejects.toMatchObject({ code: 'identity-unavailable', retryable: true });
  });
  it('an operation outside the contract is refused', async () => {
    const w = world(), e = client('user_e');
    w.seed(e, 'editor', CASE_1);
    expect(await outcome(call(w, e, 'publish' as CaseOperation))).toBe('forbidden');
  });
});
