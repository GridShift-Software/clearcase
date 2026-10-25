// Refusals at the HTTP seam against the real core: each leaves the source, target and audit untouched unless it says otherwise.
import { afterEach, describe, expect, it } from 'vitest';
import { CASE, auditViewers, auditViewKey } from '../recovery-native-adapters/world.ts';
import { POLICY } from '../recovery-native-evidence/world.ts';
import { createRecoveryController } from '../../../src/lib/recovery/hosted/http.ts';
import { nativeRecoveryBinding } from '../../../src/lib/recovery/hosted/composition.ts';
import { recoveryControllerFor } from '../../../src/lib/recovery/hosted/composition.ts';
import { EXPORT, ORIGIN, ROUTES, bindingOf, body, expectUntouched, pair, post, run, snapshot, type Pair, type Step } from './fixture.ts';
const live: Pair[] = [];
afterEach(() => { for (const p of live.splice(0)) for (const w of p.worlds) w.close(); });
async function setup() { const p = await pair(); live.push(p); return { p, deps: await p.source.deps() }; }
const PIN = { exportId: 'http-e1', expectedManifestSha256: 'b'.repeat(64) };
const APPLY = { ...PIN, confirmedPlanSha256: 'c'.repeat(64), operationId: 'http-op' };
const SHAPES: Record<Step, unknown> = { export: EXPORT, verify: PIN, plan: PIN, apply: APPLY };
const STEPS = Object.keys(SHAPES) as Step[];

describe('exact request binding', () => {
  it.each(STEPS)('%s: a cloned or unknown request is 503 and touches nothing', async (step) => {
    const { p, deps } = await setup(), who = p.source.identity, bound = post(step, SHAPES[step]);
    const before = snapshot(p);
    const clone = new Request(bound.clone());
    expect((await run(step, bound, who, bindingOf(deps))).status).not.toBe(503); // admitted, then refused by the core on its own terms
    const afterBound = snapshot(p);
    const res = await run(step, clone, who, null);
    expect(res.status).toBe(503);
    expect(await body(res)).toMatchObject({ code: 'recovery-unavailable' });
    expectUntouched(p, afterBound);
    expect(before).toBeDefined();
  });
  it('separates concurrent requests that carry the same URL', async () => {
    const a = await setup(), b = await setup();
    const ra = post('export', EXPORT), rb = post('export', EXPORT);
    const [one, two] = await Promise.all([
      run('export', ra, a.p.source.identity, bindingOf(a.deps)), run('export', rb, b.p.source.identity, bindingOf(b.deps)),
    ]);
    expect([one.status, two.status]).toEqual([201, 201]);
    for (const w of [a.p, b.p]) expect(w.source.bucket.puts.filter((k) => k.endsWith('/http-e1/manifest.json'))).toHaveLength(1);
    // A third request bound only to world A cannot reach world B's data.
    const rc = post('export', { ...EXPORT, exportId: 'http-e2' });
    expect((await run('export', rc, a.p.source.identity, bindingOf(a.deps))).status).toBe(201);
    expect(b.p.source.bucket.puts.filter((k) => k.includes('/http-e2/'))).toEqual([]);
  });
  it('copies the binding: mutating the parent object afterwards changes nothing', async () => {
    const { p, deps } = await setup();
    const mutable = { appOrigin: ORIGIN, caseId: CASE, deps, restore: null as ReturnType<typeof bindingOf>['restore'] };
    const frozen = nativeRecoveryBinding(mutable);
    mutable.appOrigin = 'https://evil.example';
    expect(frozen.appOrigin).toBe(ORIGIN);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect((await run('export', post('export', EXPORT), p.source.identity, frozen)).status).toBe(201);
  });
  it('rejects a malformed configured origin when the parent binds it', async () => {
    const { deps } = await setup();
    expect(() => nativeRecoveryBinding({ appOrigin: `${ORIGIN}/path`, caseId: CASE, deps, restore: null })).toThrow();
    expect(() => nativeRecoveryBinding({ appOrigin: 'not a url', caseId: CASE, deps, restore: null })).toThrow();
  });
  it('is unavailable with no composition installed for the request at all', async () => {
    const controller = await recoveryControllerFor({ request: post('export', EXPORT), platform: null });
    const request = post('export', EXPORT);
    expect((await controller.exportArchive({ request, url: new URL(request.url), params: { caseId: CASE }, identity: (await setup()).p.source.identity })).status).toBe(503);
  });
});

describe('identity, session and case', () => {
  it.each(STEPS)('%s: another session or principal is refused before any IO', async (step) => {
    const { p, deps } = await setup(), before = snapshot(p);
    const res = await run(step, post(step, SHAPES[step]), p.target.identity, bindingOf(deps));
    expect(res.status).toBe(503);
    expectUntouched(p, before);
  });
  it.each(STEPS)('%s: an anonymous caller is 401 before any IO', async (step) => {
    const { p, deps } = await setup(), before = snapshot(p);
    const anonymous = { kind: 'anonymous', principal: null, sessionId: null, clientId: p.source.identity.clientId, checkRevocation: async () => {}, authorize: async () => {} };
    const res = await run(step, post(step, SHAPES[step]), anonymous as never, bindingOf(deps));
    expect(res.status).toBe(401);
    expectUntouched(p, before);
  });
  it.each(STEPS)('%s: another case in the route is 404, and a case in the body is an unknown field', async (step) => {
    const { p, deps } = await setup(), before = snapshot(p);
    const other = await run(step, post(step, SHAPES[step]), p.source.identity, bindingOf(deps), { caseId: 'case-b' });
    expect(other.status).toBe(404);
    const override = await run(step, post(step, { ...(SHAPES[step] as object), caseId: 'case-b' }), p.source.identity, bindingOf(deps));
    expect(override.status).toBe(422);
    const mismatch = await run(step, post(step, SHAPES[step]), p.source.identity, bindingOf(deps, { caseId: 'case-b' as never }));
    expect(mismatch.status).toBe(404);
    expectUntouched(p, before);
  });
});

describe('absent trusted pieces stay unavailable through the real core', () => {
  it('a missing /2 policy or audit hook is 503 and writes nothing', async () => {
    for (const policy of [null, { maxLineageRows: POLICY.maxLineageRows, maxLineageBytes: POLICY.maxLineageBytes }]) {
      const { p } = await setup();
      p.source.options.nativeEvidence = policy as never;
      const before = snapshot(p);
      const res = await run('export', post('export', EXPORT), p.source.identity, bindingOf(await p.source.deps()));
      expect(res.status).toBe(503);
      expect(await body(res)).toMatchObject({ code: 'recovery-unavailable' });
      expect(snapshot(p).puts).toBe(before.puts);
    }
  });
  it.each(['plan', 'apply'] as const)('%s: no target or a non-isolated target is 503 before any target write', async (step) => {
    const { p, deps } = await setup();
    const none = await run(step, post(step, SHAPES[step]), p.source.identity, bindingOf(deps, { restore: null }));
    expect(none.status).toBe(503);
    expect(await body(none)).toMatchObject({ code: 'recovery-unavailable' });
    const same = { liveIsolationId: deps.liveIsolationId, target: { ...deps.target!, objects: deps.objects! } };
    const shared = await run(step, post(step, SHAPES[step]), p.source.identity, bindingOf(deps, { restore: same }));
    expect(shared.status).toBe(503);
    expect(await body(shared)).toMatchObject({ code: 'target-not-isolated' });
    expect(p.target.bucket.puts).toEqual([]);
  });
});

describe('denied and revoked authority', () => {
  it('a revoked grant is 403 and a revoked session is 401', async () => {
    const { p, deps } = await setup();
    p.source.revokeGrant();
    const puts = p.source.bucket.puts.length;
    const denied = await run('export', post('export', EXPORT), p.source.identity, bindingOf(deps));
    expect(denied.status).toBe(403);
    expect(p.source.bucket.puts.length).toBe(puts);
    const fresh = await setup(), freshPuts = fresh.p.source.bucket.puts.length;
    fresh.p.source.state.revoked = true;
    const revoked = await run('export', post('export', EXPORT), fresh.p.source.identity, bindingOf(fresh.deps));
    expect(revoked.status).toBe(401);
    expect(fresh.p.source.bucket.puts.length).toBe(freshPuts);
  });
  it('a missing case-audit entitlement is 403 before any private IO', async () => {
    const { p, deps } = await setup();
    auditViewers.delete(auditViewKey({ principal: p.source.identity.principal!, sessionId: p.source.identity.sessionId!, caseId: CASE }));
    const reads = p.source.bucket.reads.length, puts = p.source.bucket.puts.length;
    const res = await run('export', post('export', EXPORT), p.source.identity, bindingOf(deps));
    expect(res.status).toBe(403);
    expect(p.source.bucket.puts.length).toBe(puts);
    expect(p.source.bucket.reads.length).toBe(reads);
  });
});

describe('command bodies', () => {
  const bad: [string, string | object][] = [
    ['an unknown field', { ...EXPORT, extra: 1 }], ['a missing field', { exportId: 'http-e1' }], ['a bad export id', { ...EXPORT, exportId: '../x' }],
    ['a non-boolean selection', { ...EXPORT, includeUserWork: 'yes' }], ['a bad audit scope', { ...EXPORT, auditScope: 'all' }],
    ['a duplicate key', '{"exportId":"a","exportId":"b","includeUserWork":true}'], ['an array', '[]'], ['text', 'export please'], ['empty', ''],
    ['invalid UTF-8', '{"exportId":"\ud800","includeUserWork":true}'],
  ];
  it.each(bad)('export refuses %s with 422 before any IO', async (_name, input) => {
    const { p, deps } = await setup(), before = snapshot(p);
    const res = await run('export', post('export', typeof input === 'string' ? undefined : input, typeof input === 'string' ? { raw: input } : {}), p.source.identity, bindingOf(deps));
    expect(res.status).toBe(422);
    expectUntouched(p, before);
  });
  it.each(['verify', 'plan', 'apply'] as const)('%s refuses a bad digest, id or operation with 422', async (step) => {
    const { p, deps } = await setup(), before = snapshot(p);
    for (const patch of [{ expectedManifestSha256: 'ABC' }, { exportId: '' }, ...(step === 'apply' ? [{ confirmedPlanSha256: 'z' }, { operationId: '/' }] : [])]) {
      const res = await run(step, post(step, { ...(SHAPES[step] as object), ...patch }), p.source.identity, bindingOf(deps));
      expect(res.status).toBe(422);
    }
    expectUntouched(p, before);
  });
  it('an oversized body, declared or streamed, is 413 before any IO', async () => {
    const { p, deps } = await setup(), before = snapshot(p);
    const big = JSON.stringify({ ...EXPORT, exportId: 'x'.repeat(4000) });
    expect((await run('export', post('export', undefined, { raw: big }), p.source.identity, bindingOf(deps))).status).toBe(413);
    const lying = post('export', undefined, { raw: big, headers: { 'content-length': '10' } });
    expect((await run('export', lying, p.source.identity, bindingOf(deps))).status).toBe(413);
    expectUntouched(p, before);
  });
});

describe('origin, media type and method', () => {
  it.each(STEPS)('%s: a wrong or missing Origin is 403, a non-JSON media type is 415', async (step) => {
    const { p, deps } = await setup(), before = snapshot(p), binding = bindingOf(deps);
    for (const origin of ['https://evil.example', null]) expect((await run(step, post(step, SHAPES[step], { origin }), p.source.identity, binding)).status).toBe(403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) expect((await run(step, post(step, SHAPES[step], { type }), p.source.identity, binding)).status).toBe(415);
    expectUntouched(p, before);
  });
  it('refuses a cross-origin request even with no binding, and the configured origin is binding for same-origin lookalikes', async () => {
    const { p, deps } = await setup(), puts = p.source.bucket.puts.length;
    expect((await run('export', post('export', EXPORT, { origin: 'https://evil.example' }), p.source.identity, null)).status).toBe(403);
    const wrongApp = bindingOf(deps, { appOrigin: 'https://other.example' });
    expect((await run('export', post('export', EXPORT), p.source.identity, wrongApp)).status).toBe(403);
    expect(p.source.bucket.puts.length).toBe(puts);
  });
  it('exposes only POST: no route module has a GET, and the controller refuses any other method', async () => {
    const { p, deps } = await setup(), before = snapshot(p);
    for (const route of Object.values(ROUTES)) expect(Object.keys(route)).toEqual(['POST']);
    const controller = createRecoveryController(bindingOf(deps)), request = post('export', undefined, { method: 'GET' });
    const res = await controller.exportArchive({ request, url: new URL(request.url), params: { caseId: CASE }, identity: p.source.identity });
    expect(res.status).toBe(405);
    expectUntouched(p, before);
  });
});
