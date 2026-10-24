import type { ClientId } from '../../server/runtime/contracts.ts';
import type { CloudBindings } from './bindings.ts';
import { IDENTITY_KEY } from './keys.ts';

export const LAYOUT = 'clearcase.rs/1';
export type GateFailure = 'missing-identity' | 'crossed-binding' | 'unreachable';

/**
 * The storage gate: the database's `rs_storage_identity` row and the bucket's `identity/client.json` must both name the
 * deployment's client, which comes from trusted configuration only. The first success is kept for the life of the
 * factory (an isolate: bindings cannot change under it); a failure is never kept, so the next call checks again.
 */
export function storageGate(b: CloudBindings, clientId: ClientId): () => Promise<GateFailure | null> {
  let passed = false;
  return async () => {
    if (passed) return null;
    let row: { client_id: string; layout: string } | null, object: Awaited<ReturnType<typeof b.bucket.get>>;
    try {
      row = await b.db.prepare('SELECT client_id, layout FROM rs_storage_identity WHERE singleton = 1').first();
      object = await b.bucket.get(IDENTITY_KEY);
    } catch { return 'unreachable'; }
    if (!row || !object) return 'missing-identity';
    let named: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await object.arrayBuffer());
      if (text.length > 1024) return 'crossed-binding';
      named = (JSON.parse(text) as { client_id?: unknown }).client_id;
    } catch { return 'crossed-binding'; }
    if (row.client_id !== clientId || row.layout !== LAYOUT || named !== clientId) return 'crossed-binding';
    passed = true;
    return null;
  };
}
