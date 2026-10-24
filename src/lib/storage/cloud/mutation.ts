import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { contractError, isDenial } from '../../server/runtime/errors.ts';
import { storageAccess, type OpenStorage } from './access.ts';
import { budgetsConsistent } from './budgets.ts';
import type { StorageContext } from './context.ts';
import { quotasValid, type StorageQuotas } from './quotas.ts';

/**
 * What a storage mutation asks the deployment to authorize. This is storage's own typed capability request: it does not
 * extend the runtime's `CaseOperation` union (read, read-original, read-preview, ...). The composition adapts it to the
 * identity service's capability check (GRS-114 `authorizeCapability`); nothing here invents authority.
 */
export type StorageCapability = 'original.upload' | 'results.import';
export type StorageStep = 'declare' | 'put' | 'finalize' | 'stage';
export interface StorageMutation {
  /** The deployment's trusted client, never a request value. */
  readonly clientId: ClientId;
  readonly caseId: CaseId;
  readonly capability: StorageCapability;
  readonly step: StorageStep;
  readonly operationId: string;
}
/** Resolves to allow; rejects (a `forbidden`-style denial) to refuse. Resolving `false` is also a refusal. */
export type AuthorizeMutation = (m: StorageMutation) => Promise<void>;

export interface OpenWriter extends OpenStorage { quotas: StorageQuotas }

/**
 * Opens storage for one mutation step: first the injected capability check (a missing callback denies, a refusal is
 * rethrown, a fault of the callback is a retryable unavailability, never an allow), then the storage gate, then the
 * budget and quota invariants. No row is read or written, and no object touched, before the capability is granted.
 */
export function writerAccess(ctx: StorageContext, capability: StorageCapability): (step: StorageStep, caseId: CaseId, operationId: string) => Promise<OpenWriter> {
  const open = storageAccess(ctx, 'storage-unavailable');
  return async (step, caseId, operationId) => {
    const authorize: unknown = ctx.authorize;
    if (typeof authorize !== 'function') throw contractError('forbidden');
    if (!ctx.clientId) throw contractError('storage-unavailable', true);
    let verdict: unknown;
    try { verdict = await authorize({ clientId: ctx.clientId, caseId, capability, step, operationId } satisfies StorageMutation); }
    catch (e) { throw isDenial(e) ? e : contractError('storage-unavailable', true); }
    if (verdict === false) throw contractError('forbidden');
    const s = await open();
    if (!budgetsConsistent(s.budgets) || !quotasValid(ctx.quotas)) throw contractError('storage-unavailable', true);
    return { ...s, quotas: ctx.quotas };
  };
}
