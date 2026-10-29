import type { ClientId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import type { CloudBindings } from './bindings.ts';
import type { StorageBudgets } from './budgets.ts';
import { storageGate } from './gate.ts';

export interface OpenStorage extends CloudBindings { clientId: ClientId; budgets: StorageBudgets }
export type StorageOpener = (() => Promise<OpenStorage>) & {
  /**
   * `read` over the storage, started beside the gate instead of after it. Its result is released only once the gate has
   * passed; a refused gate refuses with the opener's code whatever `read` returned. `read` must not write.
   */
  beside<T>(read: (s: OpenStorage) => Promise<T>): Promise<T>;
};
/**
 * Storage that opens only for its own client: with bindings, a trusted client id and every budget present, and the
 * storage gate passed. Anything else refuses with `code` (retryable), before a row or object is read.
 */
export function storageAccess<C extends string>(a: { bindings: CloudBindings | null; clientId: ClientId | null; budgets: StorageBudgets | null }, code: C): StorageOpener {
  const { bindings, clientId, budgets } = a;
  const gate = bindings && clientId ? storageGate(bindings, clientId) : null;
  const storage = () => {
    if (!bindings || !clientId || !budgets || !gate) throw contractError(code, true);
    return { ...bindings, clientId, budgets };
  };
  const open = async () => {
    const s = storage();
    if ((await gate!()) !== null) throw contractError(code, true);
    return s;
  };
  const beside = async <T>(read: (s: OpenStorage) => Promise<T>) => {
    const s = storage();
    const [passed, value] = await Promise.allSettled([gate!(), read(s)]);
    if (passed.status === 'rejected' || passed.value !== null) throw contractError(code, true);
    if (value.status === 'rejected') throw value.reason;
    return value.value;
  };
  return Object.assign(open, { beside });
}
