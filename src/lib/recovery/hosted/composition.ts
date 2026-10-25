import type { CaseId } from '../../server/runtime/contracts.ts';
import { createRecoveryController, type RecoveryController } from './http.ts';
import type { RestoreTarget } from './restore.ts';
import type { RecoveryDeps } from './types.ts';

/**
 * What the trusted parent binds for ONE exact request: the configured app origin, the route's case, that request's own
 * authenticated deps (identity, audit, stores, native /2 evidence port) and, only when a genuine isolated restore
 * target exists, the live isolation label and that target. Nothing here is derived from the request itself.
 */
export interface NativeRecoveryBinding {
  readonly appOrigin: string;
  readonly caseId: CaseId;
  readonly deps: RecoveryDeps;
  readonly restore: { readonly liveIsolationId: string; readonly target: RestoreTarget } | null;
}

/** Validates and freezes a copy; a malformed origin refuses here rather than at a later comparison. */
export function nativeRecoveryBinding(a: NativeRecoveryBinding): NativeRecoveryBinding {
  const origin = new URL(a.appOrigin).origin;
  if (origin === 'null' || origin !== a.appOrigin) throw new Error('appOrigin must be an exact URL origin');
  return Object.freeze({ appOrigin: origin, caseId: a.caseId, deps: a.deps, restore: a.restore ? Object.freeze({ ...a.restore }) : null });
}

/** Resolves the binding for this exact Request object; unknown, cloned or unbound requests return null. */
export type RecoveryComposition = (a: { request: Request; platform: unknown }) => NativeRecoveryBinding | null | Promise<NativeRecoveryBinding | null>;
let composition: RecoveryComposition | null = null;

export function setRecoveryComposition(c: RecoveryComposition | null): void { composition = c; }

/** The controller for one request: its binding, or the unconfigured controller that refuses with 503. */
export async function recoveryControllerFor(a: { request: Request; platform: unknown }): Promise<RecoveryController> {
  let binding: NativeRecoveryBinding | null = null;
  if (composition) { try { binding = await composition(a); } catch { binding = null; } }
  return createRecoveryController(binding);
}
