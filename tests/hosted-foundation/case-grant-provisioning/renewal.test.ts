// Trusted control-plane renewal of an expiring or expired case grant, on the real adapters and synthetic schemas behind a
// local D1-shaped SQLite transport. Not hosted proof. Every instant is derived from the fixture clock.
import { describe, expect, it } from 'vitest';
import { effective, type GrantRecord } from '../../../src/lib/tenancy/grants.ts';
import { createManagerBootstrap } from '../../../src/lib/tenancy/provisioning.ts';
import { ALICE, CASE_1, CASE_2, INPUT, ISSUER_A, ISSUER_C, STAFF, world } from './world.ts';

const DAY = 86_400_000;
type World = Awaited<ReturnType<typeof world>>;
const at = (w: World, ms: number) => new Date(w.now().getTime() + ms).toISOString();
const held = (w: World, principal: typeof ALICE | typeof STAFF = ALICE, caseId = CASE_1) => w.grants.grantsOf({ clientId: w.deployment.clientId, principal, scope: { kind: 'case', caseId } });
const authorised = async (w: World, principal: typeof ALICE | typeof STAFF = ALICE, caseId = CASE_1) =>
  (await held(w, principal, caseId)).some((g) => effective(g, { clientId: w.deployment.clientId, principal, scope: { kind: 'case', caseId }, now: w.now() }));

/** Alice's viewer grant on case 1, provisioned to expire in a day, then two days later: expired but still `active`. */
async function expired(w: World, over: Partial<typeof INPUT> = {}): Promise<GrantRecord> {
  const made = await w.make().grantCase({ ...INPUT, ...over, expiresAt: at(w, DAY) } as never);
  if (made.kind !== 'applied') throw new Error(`fixture grant not applied: ${made.kind}`);
  w.advance(2 * DAY);
  return made.grant;
}
const renewalOf = (w: World, grant: GrantRecord, over: Record<string, unknown> = {}) => ({
  operator: 'alpha-renew-1', operationId: 'case-renew-1', grantId: grant.grantId, target: ALICE, caseId: CASE_1, role: 'viewer' as const, expiresAt: at(w, 7 * DAY), ...over,
});

describe('trusted control-plane renewal of a case grant', () => {
  it('reproduces the lockout: an expired grant holds its slot, so grantCase cannot restore it', async () => {
    const w = await world();
    await expired(w);
    expect(await authorised(w)).toBe(false);
    expect(await w.make().grantCase({ ...INPUT, operationId: 'case-grant-again', expiresAt: at(w, 7 * DAY) })).toEqual({ kind: 'conflict', reason: 'slot-taken' });
  });

  it('renews an expired grant and restores authority through effective()', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    const result = await w.renewal().renewCaseGrant(input);
    expect(result).toMatchObject({ kind: 'applied', repeated: false, grant: { state: 'active', version: 2, role: 'viewer', scope: { kind: 'case', caseId: CASE_1 }, issuer: ALICE.issuer, subject: ALICE.subject, principalKind: 'client', expiresAt: input.expiresAt, supersedes: old.grantId, createdOperationId: input.operationId, createdBy: { issuer: 'control-plane:client-a', subject: input.operator } } });
    expect(await authorised(w)).toBe(true);
    expect(await held(w)).toHaveLength(1);
    expect(await w.grants.get({ clientId: w.deployment.clientId, grantId: old.grantId })).toMatchObject({ state: 'revoked', revokedOperationId: input.operationId });
    // The renewal grants exactly the old role and nothing else.
    expect(await authorised(w, ALICE, CASE_2)).toBe(false);
    expect(await w.grants.grantsOf({ clientId: w.deployment.clientId, principal: ALICE, scope: { kind: 'client' } })).toEqual([]);
    // Authority ends at the new expiry.
    w.advance(7 * DAY);
    expect(await authorised(w)).toBe(false);
  });

  it('extends an unexpired grant to a later expiry within 30 days, inclusive', async () => {
    const w = await world();
    const made = await w.make().grantCase({ ...INPUT, expiresAt: at(w, DAY) });
    if (made.kind !== 'applied') throw new Error('expected applied');
    expect(await w.renewal().renewCaseGrant(renewalOf(w, made.grant, { expiresAt: at(w, 30 * DAY) }))).toMatchObject({ kind: 'applied', grant: { supersedes: made.grant.grantId } });
    expect(await authorised(w)).toBe(true);
  });

  it('records a superseded and replaced pair in the grant ledger and the audit log', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    const result = await w.renewal().renewCaseGrant(input);
    if (result.kind !== 'applied') throw new Error('expected applied');
    const replacement = result.grant;
    expect(await w.audit.find(`grant-op:${INPUT.operationId}`)).toMatchObject({ action: 'grant.provision', object: { kind: 'case-grant', id: old.grantId, caseId: CASE_1 } });
    expect(await w.audit.find(`grant-op:${input.operationId}`)).toEqual({
      eventId: `grant-op:${input.operationId}`, actor: { kind: 'system', component: 'provisioning', operator: input.operator }, action: 'grant.renew',
      object: { kind: 'case-grant', id: replacement.grantId, caseId: CASE_1 }, version: null, outcome: 'succeeded', at: w.now().toISOString(),
    });
    expect(w.auditRows()).toHaveLength(2);
    expect(w.grantRows()).toMatchObject([
      { grant_id: old.grantId, state: 'revoked', revoked_operation_id: input.operationId, revoked_at: w.now().toISOString(), supersedes: null },
      { grant_id: replacement.grantId, state: 'active', created_operation_id: input.operationId, supersedes: old.grantId },
    ]);
    expect(w.operationRows()).toMatchObject([
      { operation_id: INPUT.operationId, operation: 'create', grant_id: old.grantId, state: 'audited' },
      { operation_id: input.operationId, operation: 'update', grant_id: replacement.grantId, actor_kind: 'control-plane', actor_issuer: 'control-plane:client-a', actor_subject: input.operator, state: 'audited' },
    ]);
  });

  it('is a separate renewal-only factory; the creation producer keeps one method', async () => {
    const w = await world();
    expect(Object.keys(w.renewal())).toEqual(['renewCaseGrant']);
    expect(Object.keys(w.make())).toEqual(['grantCase']);
  });
});

describe('renewal refusals', () => {
  it('refuses a grant that does not exist: creation is grantCase\'s job', async () => {
    const w = await world();
    const before = { grantId: 'no-such-grant' } as GrantRecord;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, before))).toEqual({ kind: 'gone' });
    expect(w.writes()).toEqual([]);
  });

  it.each([
    { over: { role: 'editor' }, why: 'role' }, { over: { caseId: CASE_2 }, why: 'case' },
    { over: { target: STAFF }, why: 'issuer and kind' }, { over: { target: { ...ALICE, subject: 'user_bob' } }, why: 'subject' },
  ])('refuses when the $why differs from the prior grant', async ({ over }) => {
    const w = await world(), old = await expired(w);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, over))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
    expect(w.grantRows()).toMatchObject([{ grant_id: old.grantId, state: 'active' }]);
  });

  it('refuses a client-wide grant-admin grant, whatever role the request names', async () => {
    const w = await world();
    const boot = await createManagerBootstrap(w.options).grantManager({ operator: 'boot', operationId: 'boot-1', target: ALICE, expiresAt: at(w, DAY) });
    if (boot.kind !== 'applied') throw new Error('expected applied');
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, boot.grant))).toMatchObject({ kind: 'invalid' });
    expect(await w.renewal().renewCaseGrant(renewalOf(w, boot.grant, { role: 'grant-admin' }))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('refuses a revoked prior grant without resurrecting it', async () => {
    const w = await world(), old = await expired(w);
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old))).toMatchObject({ kind: 'applied' });
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, { operationId: 'case-renew-2', expiresAt: at(w, 8 * DAY) }))).toEqual({ kind: 'stale' });
    expect(w.writes()).toEqual([]);
    expect(w.grantRows()).toHaveLength(2);
  });

  it('refuses a prior grant still pending its audit acknowledgement', async () => {
    const w = await world();
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    const made = await w.make().grantCase({ ...INPUT, expiresAt: at(w, DAY) });
    if (made.kind !== 'audit-pending') throw new Error('expected audit-pending');
    w.hooks.failSql = null; w.hooks.sql.length = 0;
    const [pending] = await held(w);
    expect(await w.renewal().renewCaseGrant(renewalOf(w, pending!))).toEqual({ kind: 'stale' });
    expect(w.writes()).toEqual([]);
  });

  it.each([
    { why: 'equal to the current expiry', expiresAt: (w: World, old: GrantRecord) => old.expiresAt },
    { why: 'earlier than the current expiry', expiresAt: (w: World, old: GrantRecord) => new Date(Date.parse(old.expiresAt!) - 1000).toISOString() },
    { why: 'more than 30 days out', expiresAt: (w: World) => at(w, 30 * DAY + 1) },
    { why: 'never expiring', expiresAt: () => null },
  ])('refuses a new expiry $why on an unexpired grant', async ({ expiresAt }) => {
    const w = await world();
    const made = await w.make().grantCase({ ...INPUT, expiresAt: at(w, 2 * DAY) });
    if (made.kind !== 'applied') throw new Error('expected applied');
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, made.grant, { expiresAt: expiresAt(w, made.grant) }))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it.each([
    { why: 'in the past', expiresAt: (w: World) => at(w, -1000) },
    { why: 'now', expiresAt: (w: World) => at(w, 0) },
    { why: 'later than the current expiry but already past', expiresAt: (w: World, old: GrantRecord) => new Date(Date.parse(old.expiresAt!) + 1000).toISOString() },
  ])('refuses a new expiry $why on an expired grant', async ({ expiresAt }) => {
    const w = await world(), old = await expired(w);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, { expiresAt: expiresAt(w, old) }))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('fails closed on a stored expiry that is not an exact instant', async () => {
    const w = await world(), old = await expired(w);
    w.sqlite.prepare("UPDATE tenant_case_grants SET expires_at = 'garbage' WHERE grant_id = ?").run(old.grantId);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('refuses to renew a grant that never expires', async () => {
    const w = await world();
    const made = await w.make().grantCase(INPUT);
    if (made.kind !== 'applied') throw new Error('expected applied');
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, made.grant))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it.each([
    { operator: '' }, { operator: 'staff user' }, { operationId: '' }, { operationId: 'bad op' }, { operationId: 'x'.repeat(120) },
    { grantId: '' }, { grantId: 'bad grant' }, { grantId: 7 }, { grantId: undefined },
    { target: null }, { target: { ...ALICE, subject: '' } }, { target: { ...ALICE, issuer: `${ISSUER_A}/` } }, { target: { ...ALICE, kind: 'staff' } },
    { role: 'owner' }, { role: null }, { caseId: '' }, { caseId: 'case:1' }, { caseId: 'unknown-case' },
    { expiresAt: undefined }, { expiresAt: 0 }, { expiresAt: 'next week' },
  ])('rejects invalid input before any write: %j', async (over) => {
    const w = await world(), old = await expired(w);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, over) as never)).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it.each([null, undefined, {}])('rejects a missing input: %j', async (input) => {
    const w = await world();
    expect(await w.renewal().renewCaseGrant(input as never)).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('requires the supersede-capable grant repository, a case directory and an append-plus-find audit port', async () => {
    const w = await world();
    expect(() => w.renewal({ grants: { ...w.grants, supersede: undefined } as never })).toThrow(TypeError);
    expect(() => w.renewal({ cases: undefined as never })).toThrow(TypeError);
    expect(() => w.renewal({ audit: { append: w.audit.append } as never })).toThrow(TypeError);
  });
});

describe('renewal across clients', () => {
  it('refuses a principal of a foreign client before any write', async () => {
    const w = await world(), old = await expired(w);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, { target: { ...ALICE, issuer: ISSUER_C } }))).toMatchObject({ kind: 'invalid' });
    expect(w.writes()).toEqual([]);
  });

  it('cannot reach a foreign client\'s grant id from this client\'s instance', async () => {
    const a = await world(), c = await world('c');
    const charlie = { ...ALICE, issuer: ISSUER_C, subject: 'user_charlie' } as const;
    const foreign = await expired(c, { target: charlie } as never);
    a.advance(2 * DAY);
    a.hooks.sql.length = 0;
    expect(await a.renewal().renewCaseGrant(renewalOf(a, foreign))).toEqual({ kind: 'gone' });
    expect(await a.renewal().renewCaseGrant(renewalOf(a, foreign, { target: charlie }))).toMatchObject({ kind: 'invalid' });
    expect(a.writes()).toEqual([]);
    expect(c.grantRows()).toMatchObject([{ grant_id: foreign.grantId, state: 'active' }]);
  });

  it('ignores a foreign-tenant row planted in this client\'s database, even for its own principal shape', async () => {
    const w = await world(), old = await expired(w);
    // A row naming another client in this database (a misrouted write) is not this client's grant to renew.
    w.sqlite.prepare("INSERT INTO tenant_case_grants SELECT 'planted-foreign', 'client-c', scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version, 'planted-op', request, created_by_issuer, created_by_subject, created_at, supersedes, revoked_operation_id, revoked_at FROM tenant_case_grants WHERE grant_id = ?").run(old.grantId);
    w.hooks.sql.length = 0;
    expect(await w.renewal().renewCaseGrant(renewalOf(w, { grantId: 'planted-foreign' } as GrantRecord))).toEqual({ kind: 'gone' });
    expect(w.writes()).toEqual([]);
  });
});

describe('renewal operation replay, audit acknowledgement and competing writers', () => {
  it('replays the same operation idempotently, with no further write', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    const first = await w.renewal().renewCaseGrant(input);
    if (first.kind !== 'applied') throw new Error('expected applied');
    const writes = w.writes().length;
    w.advance(60_000);
    expect(await w.restartRenewal().renewCaseGrant(input)).toEqual({ ...first, repeated: true });
    expect(w.writes()).toHaveLength(writes);
    expect(w.grantRows()).toHaveLength(2);
    expect(w.auditRows()).toHaveLength(2);
  });

  it.each([
    { why: 'expiry', over: (w: World): Record<string, unknown> => ({ expiresAt: at(w, 8 * DAY) }) }, { why: 'operator', over: () => ({ operator: 'another-operator' }) },
    { why: 'role', over: () => ({ role: 'editor' }) }, { why: 'grant', over: () => ({ grantId: 'another-grant' }) },
  ])('refuses a different $why on a used operation id', async ({ over }) => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    expect(await w.renewal().renewCaseGrant(input)).toMatchObject({ kind: 'applied' });
    expect(await w.renewal().renewCaseGrant({ ...input, ...over(w) } as never)).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(w.grantRows()).toHaveLength(2);
  });

  it('shares operation-id uniqueness with grantCase both ways', async () => {
    const w = await world(), old = await expired(w);
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old, { operationId: INPUT.operationId }))).toEqual({ kind: 'conflict', reason: 'operation-reused' });
    expect(await w.renewal().renewCaseGrant(renewalOf(w, old))).toMatchObject({ kind: 'applied' });
    expect(await w.make().grantCase({ ...INPUT, operationId: 'case-renew-1', caseId: CASE_2 })).toEqual({ kind: 'conflict', reason: 'operation-reused' });
  });

  it('never honours expired authority while the renewal is in flight, then resumes after restart', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    expect(await w.renewal().renewCaseGrant(input)).toMatchObject({ kind: 'audit-pending', retryable: true });
    // The old grant is revoked and its replacement is pending in one batch: nothing counts until the audit event lands.
    expect(w.grantRows()).toMatchObject([{ grant_id: old.grantId, state: 'revoked' }, { state: 'pending', supersedes: old.grantId }]);
    expect(await authorised(w)).toBe(false);
    expect(await w.make().grantCase({ ...INPUT, operationId: 'case-grant-race', expiresAt: at(w, DAY) })).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    w.hooks.failSql = null; w.advance(60_000);
    expect(await w.restartRenewal().renewCaseGrant(input)).toMatchObject({ kind: 'applied', repeated: true, grant: { state: 'active', supersedes: old.grantId } });
    expect(await authorised(w)).toBe(true);
    expect(w.auditRows()).toHaveLength(2);
  });

  it('settles an exact replay after the new expiry passed without making it effective', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old, { expiresAt: at(w, 1000) });
    w.hooks.failSql = /INSERT INTO native_audit_events/;
    expect(await w.renewal().renewCaseGrant(input)).toMatchObject({ kind: 'audit-pending' });
    w.hooks.failSql = null; w.advance(31 * DAY);
    expect(await w.restartRenewal().renewCaseGrant(input)).toMatchObject({ kind: 'applied', repeated: true, grant: { expiresAt: input.expiresAt } });
    expect(await authorised(w)).toBe(false);
  });

  it.each([false, true])('retries a supersede batch fault with durable acknowledgement lost=%s', async (lost) => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    w.hooks.failGrantBatch = !lost; w.hooks.loseGrantBatchAck = lost;
    await expect(w.renewal().renewCaseGrant(input)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.grantRows()).toHaveLength(lost ? 2 : 1);
    expect(await authorised(w)).toBe(false);
    w.hooks.failGrantBatch = false; w.hooks.loseGrantBatchAck = false;
    expect(await w.restartRenewal().renewCaseGrant(input)).toMatchObject({ kind: 'applied', repeated: lost });
    expect(w.grantRows()).toHaveLength(2);
    expect(await authorised(w)).toBe(true);
  });

  it('settles a concurrent double renew to one active row', async () => {
    const w = await world(), old = await expired(w);
    w.hooks.sql.length = 0;
    const results = await Promise.all([
      w.renewal().renewCaseGrant(renewalOf(w, old)),
      w.renewal().renewCaseGrant(renewalOf(w, old, { operationId: 'case-renew-2', operator: 'alpha-renew-2', expiresAt: at(w, 9 * DAY) })),
    ]);
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind !== 'applied')).toEqual([{ kind: 'stale' }]);
    // Both read the old grant active and tried the supersede batch: the loser lost the version compare-and-set.
    expect(w.writes().filter((sql) => /SET state = 'revoked'/.test(sql))).toHaveLength(2);
    expect(await held(w)).toMatchObject([{ state: 'active', supersedes: old.grantId }]);
    expect(w.grantRows()).toHaveLength(2);
    expect(w.operationRows()).toHaveLength(2);
    expect(w.auditRows()).toHaveLength(2);
    expect(await authorised(w)).toBe(true);
  });

  it('settles competing identical renewals to one replacement and one event', async () => {
    const w = await world(), old = await expired(w), input = renewalOf(w, old);
    const results = await Promise.all(Array.from({ length: 6 }, () => w.renewal().renewCaseGrant(input)));
    expect(results.every((r) => r.kind === 'applied')).toBe(true);
    expect(new Set(results.map((r) => (r.kind === 'applied' ? r.grant.grantId : null))).size).toBe(1);
    expect(w.grantRows()).toHaveLength(2);
    expect(w.operationRows()).toHaveLength(2);
    expect(w.auditRows()).toHaveLength(2);
  });
});

describe('grantCase leaves a refused operation id unused', () => {
  it('records no operation for a slot-taken create, so the id stays free', async () => {
    const w = await world();
    await expired(w);
    expect(await w.make().grantCase({ ...INPUT, operationId: 'case-grant-2', expiresAt: at(w, DAY) })).toEqual({ kind: 'conflict', reason: 'slot-taken' });
    expect(await w.grants.operationOf({ clientId: w.deployment.clientId, operationId: 'case-grant-2' })).toBeNull();
    expect(await w.audit.find('grant-op:case-grant-2')).toBeNull();
    expect(await w.make().grantCase({ ...INPUT, operationId: 'case-grant-2', caseId: CASE_2, expiresAt: at(w, DAY) })).toMatchObject({ kind: 'applied' });
  });
});
