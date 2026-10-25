import { createRecoveryController, type RecoveryController } from './http.ts';
import type { NativeRecoveryBinding } from './binding.ts';

export { nativeRecoveryBinding, openNativeRecoveryDeps, type NativeRecoveryBinding } from './binding.ts';

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
