import type { Versioned, WorkRegisterRow } from '$lib/server/runtime/contracts';
import { registerRows } from '$lib/views/litigation/hosted.server';
import { paymentOf } from '$lib/views/quantum/payments';

// Preserve the local payments read contract: register order and decimal cents serialization. A payment's `hash` is the store's
// version of its row, which the Delete names: the store refuses a delete of a row changed since the page showed it.
export function paymentsWork(rows: readonly Versioned<WorkRegisterRow>[]) {
  return registerRows(rows).map((r) => ({ ...paymentOf(r.rowId, r.fields), hash: r.version as string }));
}
