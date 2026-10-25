// Authority at the HTTP seam: one source-bound restore context, and only closed own error codes becoming statuses.
// Real core, adapters, authorizer and audit sink over synthetic D1/R2 and an already-authenticated synthetic identity.
// Not provider, Clerk or workerd acceptance.
import { afterEach, describe, expect, it } from 'vitest';
import { CASE, world } from '../recovery-native-adapters/world.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { nativeRecoveryBinding, type NativeRecoveryBinding } from '../../../src/lib/recovery/hosted/composition.ts';
import type { NativeRecoveryOptions } from '../../../src/lib/recovery/hosted/native-adapters.ts';
import { EXPORT, ORIGIN, bindingOf, body, depsOf, expectUntouched, pair, post, run, snapshot, type Pair, type Step } from './fixture.ts';

const live: Pair[] = [];
afterEach(() => { for (const p of live.splice(0)) for (const w of p.worlds) w.close(); });
const track = async () => { const p = await pair(); live.push(p); return p; };
const PIN = { exportId: 'http-e1', expectedManifestSha256: 'b'.repeat(64) };
const APPLY = { ...PIN, confirmedPlanSha256: 'c'.repeat(64), operationId: 'http-op' };
const SHAPES: Record<Step, unknown> = { export: EXPORT, verify: PIN, plan: PIN, apply: APPLY };
const STEPS = Object.keys(SHAPES) as Step[];
const RESTORE = ['plan', 'apply'] as const;
const NOT_AVAILABLE = { code: 'recovery-unavailable', message: 'Recovery is not available on this deployment yet.' };
const NOT_ISOLATED = { code: 'target-not-isolated', message: 'No isolated restore target is available.' };

/** A second, separately provisioned source/target pair whose request identity differs from the main one by `kind`. */
async function variant(kind: 'principal' | 'session' | 'case') {
  const staff = kind !== 'principal';
  const source = await world(false, true, staff), target = await world(true, true, staff);
  const p = { source, target, worlds: [source, target] } as unknown as Pair;
  live.push(p);
  source.options.target = target.options;
  if (kind === 'session') source.options.identity = { ...source.identity, sessionId: id('session', 'other-session') } as never;
  if (kind === 'case') {
    for (const w of [source, target]) {
      w.db.exec('INSERT INTO rs_case VALUES (?, ?)', 'other-case', 'Other');
      w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
        SELECT 'g-other', client_id, scope, 'other-case', issuer, subject, principal_kind, role, slot, state, version, 'op-other', request, created_by_issuer, created_by_subject, created_at FROM tenant_case_grants WHERE grant_id = 'g1'`);
    }
    source.options.caseId = 'other-case' as never; target.options.caseId = 'other-case' as never;
  }
  return { p, options: source.options as NativeRecoveryOptions, identity: source.options.identity };
}
/** The shape every refusal below shares: fixed 503, nothing private touched in either world, no matter which route. */
async function expectRefused(a: Pair, b: Pair | null, step: Step, binding: NativeRecoveryBinding, identity: Parameters<typeof run>[2], fixed: { code: string; message: string }, params?: Record<string, string>) {
  const before = [snapshot(a), b ? snapshot(b) : null] as const;
  const res = await run(step, post(step, SHAPES[step]), identity, binding, params);
  expect(res.status).toBe(503);
  expect(await body(res)).toEqual(fixed);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expectUntouched(a, before[0]);
  if (b) expectUntouched(b, before[1]!);
}

describe('one source-bound restore context', () => {
  it('a controlled positive: the bound source and its own receiving target export, plan and apply without activating', async () => {
    const p = await track(), binding = bindingOf(await depsOf(p.source.options)), who = p.source.identity;
    const out = await body(await run('export', post('export', EXPORT), who, binding));
    const pinned = { exportId: 'http-e1', expectedManifestSha256: out.manifestSha256 as string };
    const plan = (await body(await run('plan', post('plan', pinned), who, binding))).plan as { planSha256: string };
    const applied = await run('apply', post('apply', { ...pinned, confirmedPlanSha256: plan.planSha256, operationId: 'http-restore' }), who, binding);
    expect(applied.status).toBe(200);
    expect((await body(applied)).report).toMatchObject({ ok: true, activated: false });
    expect(p.target.bucket.puts.length).toBeGreaterThan(0);
  });

  it('deps are only accepted from the bridge that opened them: no copy, spread or graft is a binding', async () => {
    const a = await track(), b = await track();
    const depsA = await depsOf(a.source.options), depsB = await depsOf(b.source.options);
    const grafted = { ...depsA, target: depsB.target, liveIsolationId: depsB.liveIsolationId };
    for (const deps of [grafted, { ...depsA }, { ...depsB }]) expect(() => nativeRecoveryBinding({ appOrigin: ORIGIN, caseId: CASE, deps })).toThrow();
    expect(nativeRecoveryBinding({ appOrigin: ORIGIN, caseId: CASE, deps: depsA }).deps).toBe(depsA);
  });

  it.each(STEPS)('%s: a forged binding object carrying a grafted target is refused before any IO in either world', async (step) => {
    const a = await track(), b = await track(), who = a.source.identity;
    const depsA = await depsOf(a.source.options), depsB = await depsOf(b.source.options);
    expect((await run('export', post('export', EXPORT), who, bindingOf(depsA))).status).toBe(201); // the real archive exists: refusal is the scope, not a missing export
    const forged = Object.freeze({ appOrigin: ORIGIN, caseId: CASE, deps: Object.freeze({ ...depsA, target: depsB.target, liveIsolationId: depsB.liveIsolationId }) }) as NativeRecoveryBinding;
    await expectRefused(a, b, step, forged, who, NOT_AVAILABLE);
  });

  describe.each(['principal', 'session'] as const)('%s drift between the request and the opened context', (kind) => {
    it.each(STEPS)(`${kind}: %s with another ${kind}'s opened deps is refused before any IO`, async (step) => {
      const a = await track(), v = await variant(kind);
      await expectRefused(a, v.p, step, bindingOf(await depsOf(v.options)), a.source.identity, NOT_AVAILABLE);
    });
    it.each(STEPS)(`${kind}: %s with the main deps and another ${kind}'s request identity is refused before any IO`, async (step) => {
      const a = await track(), v = await variant(kind);
      await expectRefused(a, v.p, step, bindingOf(await depsOf(a.source.options)), v.identity, NOT_AVAILABLE);
    });
  });

  describe('case drift', () => {
    it.each(STEPS)('%s: deps opened for another case under this route case are refused before any IO', async (step) => {
      const a = await track(), v = await variant('case');
      await expectRefused(a, v.p, step, bindingOf(await depsOf(v.options)), v.identity, NOT_AVAILABLE);
    });
    it.each(STEPS)('%s: a bound and routed case that is not the opened case is refused before any IO', async (step) => {
      const a = await track(), deps = await depsOf(a.source.options);
      await expectRefused(a, null, step, bindingOf(deps, { caseId: 'case-b' as never }), a.source.identity, NOT_AVAILABLE, { caseId: 'case-b' });
    });
  });

  describe('the receiving authentication is a different session of the same person', () => {
    const mutate: [string, (o: NativeRecoveryOptions, other: Awaited<ReturnType<typeof world>>) => NativeRecoveryOptions][] = [
      ['another person', (o, other) => ({ ...o, target: { ...o.target!, identity: other.identity } })],
      ['a copy of the source identity', (o) => ({ ...o, target: { ...o.target!, identity: { ...o.identity } as never } })],
      ['the source identity itself', (o) => ({ ...o, target: { ...o.target!, identity: o.identity } })],
      ['another client', (o) => ({ ...o, target: { ...o.target!, resources: { ...o.target!.resources, deployment: { ...o.target!.resources.deployment, clientId: id('client', 'client-b') } } } })],
      ['the source database', (o) => ({ ...o, target: { ...o.target!, resources: { ...o.target!.resources, db: o.resources.db } } })],
      ['the source bucket', (o) => ({ ...o, target: { ...o.target!, resources: { ...o.target!.resources, bucket: o.resources.bucket } } })],
      ['the source worker', (o) => ({ ...o, target: { ...o.target!, resources: { ...o.target!.resources, deployment: { ...o.target!.resources.deployment, worker: o.resources.deployment.worker } } } })],
    ];
    it.each(mutate)('%s: plan and apply are 503 target-not-isolated without opening or touching the target; export still works', async (_name, change) => {
      const p = await track(), other = await world(true, true, false);
      live.push({ source: other, target: other, worlds: [other] } as unknown as Pair);
      const statements = p.target.db.statements, reads = p.target.bucket.reads.length;
      const binding = bindingOf(await depsOf(change(p.source.options, other)));
      expect(p.target.db.statements).toBe(statements);
      expect(p.target.bucket.reads.length).toBe(reads);
      for (const step of RESTORE) await expectRefused(p, null, step, binding, p.source.identity, NOT_ISOLATED);
      expect((await run('export', post('export', EXPORT), p.source.identity, binding)).status).toBe(201);
    });
    it('a receiving identity that changes after it was validated refuses plan and apply before any IO', async () => {
      const p = await track(), binding = bindingOf(await depsOf(p.source.options));
      (p.target.identity as { sessionId: unknown }).sessionId = p.source.identity.sessionId;
      for (const step of RESTORE) await expectRefused(p, null, step, binding, p.source.identity, NOT_ISOLATED);
    });
    it('no receiving target leaves plan and apply unavailable and export working', async () => {
      const p = await track(), binding = bindingOf(await depsOf({ ...p.source.options, target: null }));
      for (const step of RESTORE) await expectRefused(p, null, step, binding, p.source.identity, NOT_AVAILABLE);
      expect((await run('export', post('export', EXPORT), p.source.identity, binding)).status).toBe(201);
    });
  });

  it.each(STEPS)('%s: a source identity that changes after it was opened refuses every route before any IO', async (step) => {
    const p = await track(), binding = bindingOf(await depsOf(p.source.options));
    (p.source.identity as { sessionId: unknown }).sessionId = id('session', 'changed');
    await expectRefused(p, null, step, binding, p.source.identity, NOT_AVAILABLE);
  });

  it.each(STEPS)('%s: an equal-valued request whose opened source identity changed afterwards is refused before any IO', async (step) => {
    const p = await track(), binding = bindingOf(await depsOf(p.source.options)), equal = { ...p.source.identity };
    (p.source.identity as { sessionId: unknown }).sessionId = id('session', 'changed');
    await expectRefused(p, null, step, binding, equal, NOT_AVAILABLE);
  });

  it('separates mixed concurrent requests: only the request whose identity is the opened one reaches the core', async () => {
    const a = await track(), v = await variant('session');
    const depsA = await depsOf(a.source.options), depsV = await depsOf(v.options);
    const before = snapshot(v.p);
    const [ok, mixed, again] = await Promise.all([
      run('export', post('export', EXPORT), a.source.identity, bindingOf(depsA)),
      run('export', post('export', EXPORT), a.source.identity, bindingOf(depsV)),
      run('export', post('export', { ...EXPORT, exportId: 'http-e2' }), a.source.identity, bindingOf(depsA)),
    ]);
    expect([ok.status, mixed.status, again.status]).toEqual([201, 503, 201]);
    expect(await body(mixed)).toEqual(NOT_AVAILABLE);
    expectUntouched(v.p, before);
    expect(a.source.bucket.puts.filter((k) => k.endsWith('/http-e1/manifest.json'))).toHaveLength(1);
  });

  it('a cloned request keeps no binding even for the opened identity', async () => {
    const p = await track(), request = post('export', EXPORT), clone = new Request(request.clone());
    expect((await run('export', request, p.source.identity, bindingOf(await depsOf(p.source.options)))).status).toBe(201);
    const before = snapshot(p);
    const res = await run('export', clone, p.source.identity, null);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual(NOT_AVAILABLE);
    expectUntouched(p, before);
  });
});

describe('only a closed core code becomes a status', () => {
  const fault = async (thrown: unknown, step: Step = 'export') => {
    const p = await track(), who = p.source.identity, deps = await depsOf(p.source.options), authorize = who.authorize;
    const grants = p.source.db.rows('SELECT * FROM tenant_case_grants');
    who.authorize = (async () => { throw thrown; }) as never;
    let res: Response;
    try { res = await run(step, post(step, SHAPES[step]), who, bindingOf(deps)); } finally { who.authorize = authorize; }
    return { p, res, grants };
  };
  const fixed = async (res: Response) => { expect(res.status).toBe(503); expect(res.headers.get('retry-after')).toBe('2'); expect(await body(res)).toEqual(NOT_AVAILABLE); };
  const errorWith = (code: unknown) => Object.assign(new Error('provider said: secret-token-123'), { code });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'toLocaleString', 'propertyIsEnumerable', '__defineGetter__'])(
    'an authorization fault coded %s is the bounded 503, never a success', async (code) => {
      const { res } = await fault(errorWith(code));
      await fixed(res);
    });
  it.each(['constructor', 'toString', '__proto__'] as const)('%s is the bounded 503 on every route', async (code) => {
    for (const step of STEPS) { const { res } = await fault(errorWith(code), step); expect(res.status).toBeGreaterThanOrEqual(400); await fixed(res); }
  });
  it('an unknown code, a non-string code, no code and a non-Error value are the bounded 503 and never echo the provider', async () => {
    for (const thrown of [errorWith('not-a-core-code'), errorWith(42), errorWith(undefined), errorWith(''), new Error('plain'), 'forbidden', null, undefined, { code: 'forbidden' }, 7]) {
      const { res } = await fault(thrown);
      expect(res.status).toBe(503);
      const out = await body(res);
      expect(out).toEqual(NOT_AVAILABLE);
      expect(JSON.stringify(out)).not.toContain('secret-token');
    }
  });
  it('an inherited, accessor or Proxy code is not classification', async () => {
    class Inherited extends Error { get code() { return 'forbidden'; } }
    const accessor = new Error('x'); Object.defineProperty(accessor, 'code', { get() { throw new Error('getter ran'); } });
    const proxied = new Proxy(new Error('x'), { get() { throw new Error('trap ran'); }, getPrototypeOf() { throw new Error('trap ran'); }, getOwnPropertyDescriptor() { throw new Error('trap ran'); } });
    for (const thrown of [new Inherited('x'), accessor, proxied]) { const { res } = await fault(thrown); await fixed(res); }
  });
  it('a hostile object cannot turn a thrown refusal into a thrown handler either', async () => {
    const hostile = new Proxy({}, { get() { throw new Error('trap ran'); }, has() { throw new Error('trap ran'); }, getPrototypeOf() { throw new Error('trap ran'); } });
    const { res } = await fault(hostile);
    await fixed(res);
  });

  it('closed own codes keep their exact statuses, texts and privacy', async () => {
    const table: [string, number][] = [['forbidden', 403], ['unauthenticated', 401], ['invalid-session', 401], ['wrong-client', 401], ['not-found', 404], ['plan-mismatch', 409], ['stale-state', 409], ['audit-unavailable', 503], ['storage-unavailable', 503]];
    for (const [code, status] of table) {
      const { res } = await fault(contractError(code as never));
      expect(res.status).toBe(status);
      const out = await body(res);
      expect(out.code).toBe(code);
      expect(JSON.stringify(out)).not.toContain('secret-token');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('retry-after')).toBe(status === 503 ? '2' : null);
    }
  });
  it('a denied caller and a stale target stay 403 and 409 through the real core', async () => {
    const denied = await track();
    denied.source.revokeGrant();
    expect((await run('export', post('export', EXPORT), denied.source.identity, bindingOf(await depsOf(denied.source.options)))).status).toBe(403);
    const p = await track(), who = p.source.identity, binding = bindingOf(await depsOf(p.source.options));
    const out = await body(await run('export', post('export', EXPORT), who, binding));
    const pinned = { exportId: 'http-e1', expectedManifestSha256: out.manifestSha256 as string };
    const wrong = await run('apply', post('apply', { ...pinned, confirmedPlanSha256: 'd'.repeat(64), operationId: 'http-wrong' }), who, binding);
    expect(wrong.status).toBe(409);
    expect(await body(wrong)).toMatchObject({ code: 'plan-mismatch' });
    expect(p.target.bucket.puts).toEqual([]);
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('a body field named %s is an unknown field, not a lookup', async (name) => {
    const p = await track(), binding = bindingOf(await depsOf(p.source.options)), before = snapshot(p);
    const raw = `{"exportId":"http-e1","includeUserWork":true,${JSON.stringify(name)}:1}`;
    const res = await run('export', post('export', undefined, { raw }), p.source.identity, binding);
    expect(res.status).toBe(422);
    expectUntouched(p, before);
  });
});
