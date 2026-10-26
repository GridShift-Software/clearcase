import type { ClientId } from '../../server/runtime/contracts.ts';
import type { CloudBindings } from './bindings.ts';
import type { StorageBudgets } from './budgets.ts';
import type { AuthorizeMutation } from './mutation.ts';
import type { StorageQuotas } from './quotas.ts';
/**
 * What a storage writer needs from the deployment: every field from trusted configuration, none from a request.
 * `authorize` is required and fails closed: a writer built without it denies every mutation. `quotas` is required too:
 * without it every mutation is unavailable, never unbounded.
 */
export interface StorageContext {
  bindings: CloudBindings | null; clientId: ClientId | null; budgets: StorageBudgets | null; quotas: StorageQuotas | null;
  authorize: AuthorizeMutation; now(): Date;
}
