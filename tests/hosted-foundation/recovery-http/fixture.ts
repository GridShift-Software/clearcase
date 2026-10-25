// SYNTHETIC: the real recovery core, adapters, authorizer and audit sink; only D1 (SQLite), R2 and the already
// authenticated request identity are doubles. Not provider, Clerk or workerd acceptance.
import { expect } from 'vitest';
import { CASE, world, type World } from '../recovery-native-adapters/world.ts';
import { nativeWorld, type NativeWorld } from '../recovery-native-evidence/world.ts';
import { bindNativeRequestCompositions, installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { nativeRecoveryBinding, type NativeRecoveryBinding } from '../../../src/lib/recovery/hosted/composition.ts';
import type { RestoreDeps } from '../../../src/lib/recovery/hosted/restore.ts';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import * as exportRoute from '../../../deploy/client/routes/api/cases/[caseId]/recovery/native/export/+server.ts';
import * as verifyRoute from '../../../deploy/client/routes/api/cases/[caseId]/recovery/native/verify/+server.ts';
import * as planRoute from '../../../deploy/client/routes/api/cases/[caseId]/recovery/native/plan/+server.ts';
import * as applyRoute from '../../../deploy/client/routes/api/cases/[caseId]/recovery/native/apply/+server.ts';

export const ORIGIN = 'https://client-a.example';
export const ROUTES = { export: exportRoute, verify: verifyRoute, plan: planRoute, apply: applyRoute };
export type Step = keyof typeof ROUTES;
installNativeCompositions();

export interface Pair { source: NativeWorld; target: World; worlds: World[] }
export async function pair(): Promise<Pair> {
  const source = await nativeWorld(), target = await world(true, true, true);
  source.options.target = target.options;
  return { source, target, worlds: [source, target] };
}
export function bindingOf(deps: RestoreDeps, over: Partial<NativeRecoveryBinding> = {}): NativeRecoveryBinding {
  return nativeRecoveryBinding({ appOrigin: ORIGIN, caseId: CASE, deps, restore: deps.target ? { liveIsolationId: deps.liveIsolationId, target: deps.target } : null, ...over });
}
export function post(step: Step, body: unknown, init: { origin?: string | null; type?: string | null; method?: string; raw?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  if (init.type !== null) headers.set('content-type', init.type ?? 'application/json');
  const method = init.method ?? 'POST';
  return new Request(`${ORIGIN}/api/cases/${CASE}/recovery/native/${step}`, { method, headers, body: method === 'GET' ? undefined : init.raw ?? JSON.stringify(body) });
}
/** Binds the request exactly like the parent would (by object identity), then runs the real route module. */
export async function run(step: Step, request: Request, identity: Identity, binding: NativeRecoveryBinding | null, params: Record<string, string> = { caseId: CASE }) {
  if (binding) bindNativeRequestCompositions(request, { intake: null, downloads: null, recovery: binding });
  return ROUTES[step].POST({ request, url: new URL(request.url), params, locals: { identity } } as never);
}
export async function body(response: Response) { return await response.json() as Record<string, unknown>; }
/** Nothing private was touched: no source read/write, no target write, no audit append. */
export function snapshot(p: Pair) {
  return { reads: p.source.bucket.reads.length, puts: p.source.bucket.puts.length, targetPuts: p.target.bucket.puts.length,
    targetReads: p.target.bucket.reads.length, audit: p.source.db.rows('SELECT seq FROM native_audit_events').length };
}
export function expectUntouched(p: Pair, before: ReturnType<typeof snapshot>) { expect(snapshot(p)).toEqual(before); }
export const EXPORT = { exportId: 'http-e1', includeUserWork: true };
