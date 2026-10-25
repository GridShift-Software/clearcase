// The opened scope describes exactly the input the adapters consumed, even when the parent reuses a mutable options object
// while `openNativeRecoveryDeps` awaits; and what a Proxy-shaped error can and cannot select. Synthetic D1/R2/identity with the
// real core, adapters, authorizer and audit sink. Not provider, Clerk or workerd acceptance.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeRecoveryBinding, openNativeRecoveryDeps } from '../../../src/lib/recovery/hosted/composition.ts';
import { closedCode } from '../../../src/lib/recovery/hosted/closed-code.ts';
import type { NativeRecoveryOptions } from '../../../src/lib/recovery/hosted/native-adapters.ts';
import { EXPORT, ORIGIN, bindingOf, body, depsOf, pair, post, run, snapshot, type Pair } from './fixture.ts';

const live: Pair[] = [];
afterEach(() => { for (const p of live.splice(0)) for (const w of p.worlds) w.close(); });
const track = async () => { const p = await pair(); live.push(p); return p; };
const OTHER = 'other-case';
const NOT_ISOLATED = { code: 'target-not-isolated', message: 'No isolated restore target is available.' };
function addCase(w: { db: { exec(sql: string, ...a: unknown[]): void } }) {
  w.db.exec('INSERT INTO rs_case VALUES (?, ?)', OTHER, 'Other');
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    SELECT 'g-other', client_id, scope, ?, issuer, subject, principal_kind, role, slot, state, version, 'op-other', request, created_by_issuer, created_by_subject, created_at FROM tenant_case_grants WHERE grant_id = 'g1'`, OTHER);
}
/** A parent-owned options object that the test may mutate while the open is pending; nothing in it is shared with the world's own. */
function owned(p: Pair): NativeRecoveryOptions {
  const o = p.source.options as NativeRecoveryOptions, t = o.target!;
  return { ...o, resources: { ...o.resources, deployment: { ...o.resources.deployment } },
    target: { ...t, resources: { ...t.resources, deployment: { ...t.resources.deployment } } } };
}
async function exportThenPin(p: Pair, binding: ReturnType<typeof bindingOf>) {
  const ex = await run('export', post('export', EXPORT), p.source.identity, binding);
  expect(ex.status).toBe(201);
  return { exportId: 'http-e1', expectedManifestSha256: (await body(ex)).manifestSha256 as string };
}

describe('mutable options while the open is pending (the parent reuses its configuration object)', () => {
  it('a case changed during the await is not the recorded case: the adapters\' case is, and another bound case is refused before any IO', async () => {
    const p = await track(); for (const w of p.worlds) addCase(w);
    const o = owned(p), pending = openNativeRecoveryDeps(o);
    o.caseId = OTHER as never; // the adapters already captured the real case
    const deps = await pending;
    const binding = nativeRecoveryBinding({ appOrigin: ORIGIN, caseId: OTHER as never, deps });
    const before = { audit: snapshot(p).audit, authorizations: p.source.state.authorizations, puts: p.source.bucket.puts.length };
    const res = await run('export', post('export', EXPORT), p.source.identity, binding, { caseId: OTHER });
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ code: 'recovery-unavailable', message: 'Recovery is not available on this deployment yet.' });
    expect({ audit: snapshot(p).audit, authorizations: p.source.state.authorizations, puts: p.source.bucket.puts.length }).toEqual(before);
    // the case the adapters were really opened for still works
    expect((await run('export', post('export', EXPORT), p.source.identity, bindingOf(deps))).status).toBe(201);
  });

  it('a target nulled during the await keeps its re-observation: a changed receiving identity still refuses plan and apply', async () => {
    const p = await track(), who = p.source.identity;
    const o = owned(p), pending = openNativeRecoveryDeps(o);
    o.target = null;
    const deps = await pending;
    expect(deps.target).not.toBeNull();
    const binding = bindingOf(deps), pin = await exportThenPin(p, binding);
    (p.target.identity as { sessionId: unknown }).sessionId = who.sessionId;
    const res = await run('plan', post('plan', pin), who, binding);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual(NOT_ISOLATED);
  });

  it('a receiving identity swapped during the await is not the one observed: the identity the adapters consumed is', async () => {
    const p = await track(), who = p.source.identity;
    const o = owned(p), pending = openNativeRecoveryDeps(o);
    o.target = { ...o.target!, identity: { ...p.target.identity } as never };
    const binding = bindingOf(await pending), pin = await exportThenPin(p, binding);
    (p.target.identity as { sessionId: unknown }).sessionId = who.sessionId;
    const res = await run('plan', post('plan', pin), who, binding);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual(NOT_ISOLATED);
  });

  it('a receiving deployment edited during the await is not consumed by the adapters: they open what the scope validated', async () => {
    const p = await track(), who = p.source.identity;
    const o = owned(p), pending = openNativeRecoveryDeps(o);
    (o.target!.resources.deployment as { worker: string }).worker = o.resources.deployment.worker; // a shared worker, if the adapters read it late
    const binding = bindingOf(await pending), pin = await exportThenPin(p, binding);
    const res = await run('plan', post('plan', pin), who, binding);
    expect(res.status).toBe(200);
    expect(p.target.bucket.puts.length).toBe(0);
  });

  it('caller options are read in the synchronous part only: no property of them is read after the await', async () => {
    const p = await track(), o = owned(p), reads: Record<string, number> = {};
    const watched = ['caseId', 'identity', 'resources', 'target', 'limits', 'now', 'newId'] as const;
    const spy = { ...o } as Record<string, unknown>;
    for (const k of watched) {
      const value = spy[k];
      reads[k] = 0;
      Object.defineProperty(spy, k, { enumerable: true, configurable: true, get() { reads[k]!++; return value; } });
    }
    const pending = openNativeRecoveryDeps(spy as never);
    const atCall = { ...reads };
    for (const k of watched) expect(atCall[k]).toBeLessThanOrEqual(1);
    await pending;
    expect(reads).toEqual(atCall);
  });
});

describe('a Proxy-shaped error', () => {
  const fault = async (thrown: unknown) => {
    const p = await track(), who = p.source.identity, deps = await depsOf(p.source.options), authorize = who.authorize;
    who.authorize = (async () => { throw thrown; }) as never;
    try { return await run('export', post('export', EXPORT), who, bindingOf(deps)); } finally { who.authorize = authorize; }
  };
  const impostor = (code: string, traps: { n: number }) => new Proxy({}, {
    getPrototypeOf() { traps.n++; return Error.prototype; },
    getOwnPropertyDescriptor(_t, k) { traps.n++; return k === 'code' ? { value: code, writable: true, enumerable: true, configurable: true } : undefined; },
  });

  it('may select only a table code with the fixed text and a failure status, never a success or a raw value', async () => {
    const traps = { n: 0 };
    const res = await fault(impostor('forbidden', traps));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ code: 'forbidden', message: 'You cannot use recovery for this case.' });
    for (const code of ['constructor', 'toString', '__proto__', 'not-a-core-code', '']) {
      const other = await fault(impostor(code, { n: 0 }));
      expect(other.status).toBe(503);
      expect((await body(other)).code).toBe('recovery-unavailable');
    }
  });
  it('whatever its traps do, a throw is the bounded 503', async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('secret-token-123'); }, getOwnPropertyDescriptor() { throw new Error('secret-token-123'); } });
    const res = await fault(hostile);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await body(res))).not.toContain('secret-token');
    expect(closedCode(hostile)).toBeNull();
  });
  it('is not claimed to run no code: the comment and the doc name the traps and the missing portable check', () => {
    const files = [new URL('../../../src/lib/recovery/hosted/closed-code.ts', import.meta.url), new URL('../../../docs/acceptance/hosting/native-recovery-http.md', import.meta.url)];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f.pathname).toMatch(/trap/i);
      expect(text, f.pathname).toMatch(/isProxy/);
      expect(text, f.pathname).not.toMatch(/run no code|accessor or Proxy `code`|no caller code runs|a Proxy trap or any throw/i);
    }
  });
});
