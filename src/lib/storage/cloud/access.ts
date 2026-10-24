import type { ClientId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { CloudBindings } from './bindings.ts';
import type { StorageBudgets } from './budgets.ts';
import { storageGate } from './gate.ts';

export interface OpenStorage extends CloudBindings { clientId: ClientId; budgets: StorageBudgets }
/**
 * Storage that opens only for its own client: with bindings, a trusted client id and every budget present, and the
 * storage gate passed. Anything else refuses with `code` (retryable), before a row or object is read.
 */
export function storageAccess<C extends string>(a: { bindings: CloudBindings | null; clientId: ClientId | null; budgets: StorageBudgets | null }, code: C): () => Promise<OpenStorage> {
  const { bindings, clientId, budgets } = a;
  const gate = bindings && clientId ? storageGate(bindings, clientId) : null;
  return async () => {
    if (!bindings || !clientId || !budgets || !gate) throw contractError(code, true);
    if ((await gate()) !== null) throw contractError(code, true);
    return { ...bindings, clientId, budgets };
  };
}
