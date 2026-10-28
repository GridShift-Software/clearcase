import { createHash } from 'node:crypto';
import type { Versioned, WorkRegisterRow } from '$lib/server/runtime/contracts';
import { paymentOf } from '$lib/views/quantum/payments';

// Preserve the local payments read contract: register order, the fields hash and decimal cents serialization.
export function paymentsWork(rows: readonly Versioned<WorkRegisterRow>[]) {
  const seq = (r: WorkRegisterRow) => typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...rows].sort((a, b) => seq(a) - seq(b) || compare(a.createdAt, b.createdAt) || compare(a.rowId, b.rowId))
    .map((r) => ({ ...paymentOf(r.rowId, r.fields), hash: createHash('sha256').update(JSON.stringify(['row', r.fields])).digest('hex').slice(0, 32) }));
}
