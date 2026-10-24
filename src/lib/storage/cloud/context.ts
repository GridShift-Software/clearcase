import type { ClientId } from '../../server/runtime/contracts.ts';
import type { CloudBindings } from './bindings.ts';
import type { StorageBudgets } from './budgets.ts';
/** What a storage writer needs from the deployment: every field from trusted configuration, none from a request. */
export interface StorageContext { bindings: CloudBindings | null; clientId: ClientId | null; budgets: StorageBudgets | null; now(): Date }
