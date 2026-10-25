import type { CaseId, Identity } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { closedCode } from './closed-code.ts';
import { createNativeRecoveryAdapters, type NativeRecoveryOptions } from './native-adapters.ts';
import type { RestoreDeps } from './restore.ts';

/**
 * What the trusted parent binds for ONE exact request: the configured app origin, the route's case and the request's own
 * deps from `openNativeRecoveryDeps`. Those deps carry the separately authenticated receiving target they were opened with
 * and there is no second entry point for one, so restore cannot be fed a context that belongs to another principal,
 * session, client or case. Nothing here is derived from the request itself.
 */
export interface NativeRecoveryBinding {
  readonly appOrigin: string;
  readonly caseId: CaseId;
  readonly deps: RestoreDeps;
}

interface Who { readonly clientId: string; readonly sessionId: string; readonly issuer: string; readonly subject: string; readonly kind: string }
const whoIs = (i: Identity): Who | null => i.kind === 'verified' ? { clientId: i.clientId, sessionId: i.sessionId, issuer: i.principal.issuer, subject: i.principal.subject, kind: i.principal.kind } : null;
const samePerson = (a: Who, b: Who) => a.clientId === b.clientId && a.issuer === b.issuer && a.subject === b.subject && a.kind === b.kind;
const sameSession = (a: Who | null, b: Who | null) => !!a && !!b && samePerson(a, b) && a.sessionId === b.sessionId;
const PLACES = ['hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const;

type Fault = 'recovery-unavailable' | 'target-not-isolated';
/** Captured when the adapters were opened; only `openNativeRecoveryDeps` writes it, so an unregistered deps object is not ours. */
interface Scope { readonly caseId: CaseId; readonly identity: Identity; readonly who: Who; readonly receiving: { readonly identity: Identity; readonly who: Who } | null; readonly targetFault: Fault | null }
const opened = new WeakMap<RestoreDeps, Scope>();

/** The receiving authentication must be a different session of the same person in the same client, sharing no handle or place with the source. */
function receivingFault(s: NativeRecoveryOptions, who: Who): Fault | null {
  try {
    const t = s.target!, receiving = whoIs(t.identity);
    if (!receiving || !samePerson(who, receiving) || receiving.sessionId === who.sessionId || t.identity === s.identity || t.resources.deployment.clientId !== who.clientId) return 'target-not-isolated';
    if (t.resources.db === s.resources.db || t.resources.bucket === s.resources.bucket || PLACES.some((k) => t.resources.deployment[k] === s.resources.deployment[k])) return 'target-not-isolated';
    return null;
  } catch { return 'target-not-isolated'; }
}

/**
 * Opens the reviewed adapters from ONE set of source options, whose `target` is the receiving authentication, and records the
 * scope they were opened for. A receiving target that fails its isolation or person checks is not opened: export and verify
 * keep working and plan and apply answer 503 `target-not-isolated`. Every other unusable configuration throws.
 */
export async function openNativeRecoveryDeps(options: NativeRecoveryOptions): Promise<RestoreDeps> {
  const who = whoIs(options.identity);
  let targetFault: Fault | null = null;
  try {
    if (!who || options.resources.deployment.clientId !== who.clientId) throw new Error('scope');
    if (options.target) targetFault = receivingFault(options, who);
  } catch { throw contractError('recovery-unavailable', true); }
  const withTarget = options.target && !targetFault;
  let deps: RestoreDeps;
  try { deps = await createNativeRecoveryAdapters(withTarget ? options : { ...options, target: null }); } catch (e) {
    if (!withTarget || closedCode(e) !== 'target-not-isolated') throw e;
    targetFault = 'target-not-isolated';
    deps = await createNativeRecoveryAdapters({ ...options, target: null });
  }
  if (!sameSession(whoIs(deps.identity), who)) throw contractError('recovery-unavailable', true);
  const receiving = options.target && !targetFault ? { identity: options.target.identity, who: whoIs(options.target.identity)! } : null;
  opened.set(deps, Object.freeze({ caseId: options.caseId, identity: deps.identity, who: who!, receiving, targetFault }));
  return deps;
}

/** Validates and freezes a copy; a malformed origin or deps that `openNativeRecoveryDeps` did not open refuse here. */
export function nativeRecoveryBinding(a: NativeRecoveryBinding): NativeRecoveryBinding {
  const origin = new URL(a.appOrigin).origin;
  if (origin === 'null' || origin !== a.appOrigin) throw new Error('appOrigin must be an exact URL origin');
  if (!opened.has(a.deps)) throw new Error('deps must come from openNativeRecoveryDeps');
  return Object.freeze({ appOrigin: origin, caseId: a.caseId, deps: a.deps });
}

/**
 * The in-memory scope of one request, before any SQL, storage or audit work: the request's verified identity IS the identity
 * the deps were opened for (client, session, principal), the route's bound case IS the opened case and, when the call
 * restores, the receiving authentication is the one validated at opening. A fault is a fixed 503 code naming no mismatch.
 */
export function scopeFault(b: NativeRecoveryBinding, request: Identity, restore: boolean): Fault | null {
  try {
    const scope = opened.get(b.deps);
    if (!scope || scope.caseId !== b.caseId || !sameSession(whoIs(request), scope.who) || !sameSession(whoIs(scope.identity), scope.who)) return 'recovery-unavailable';
    if (!restore) return null;
    if (scope.targetFault) return scope.targetFault;
    if (scope.receiving && !sameSession(whoIs(scope.receiving.identity), scope.receiving.who)) return 'target-not-isolated';
    return null;
  } catch { return 'recovery-unavailable'; }
}
