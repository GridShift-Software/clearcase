import { digest } from '../../server/runtime/data.ts';
import type { CloudR2 } from './bindings.ts';

export type ObjectRead = { kind: 'ok'; bytes: Uint8Array; etag: string; version: string } | { kind: 'missing' } | { kind: 'changed' } | { kind: 'over-budget' } | { kind: 'unreachable' };

/**
 * Reads one object whole and checks it against its recorded size and SHA-256 before handing back a byte. A recorded
 * size above the budget is refused before the read, and an object whose stored size is not the recorded one is not
 * downloaded at all.
 */
export async function verifiedRead(bucket: CloudR2, key: string, expected: { size: number; sha256: string }, maxBytes: number): Promise<ObjectRead> {
  if (expected.size > maxBytes) return { kind: 'over-budget' };
  let object: Awaited<ReturnType<CloudR2['get']>>;
  try { object = await bucket.get(key); } catch { return { kind: 'unreachable' }; }
  if (!object) return { kind: 'missing' };
  if (object.size !== expected.size) return { kind: 'changed' };
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await object.arrayBuffer()); } catch { return { kind: 'unreachable' }; }
  if (bytes.byteLength !== expected.size || (await digest(bytes)) !== expected.sha256) return { kind: 'changed' };
  return { kind: 'ok', bytes, etag: object.etag, version: object.version };
}

const hexOf = (b: ArrayBuffer | undefined) => (b ? [...new Uint8Array(b)].map((n) => n.toString(16).padStart(2, '0')).join('') : null);

export type WriteOnce = 'written' | 'present' | 'conflict' | 'unreachable';
/**
 * Writes `bytes` under `key` once. A key already holding the same SHA-256 and size is a no-op; anything else (other
 * bytes, or an object R2 keeps no SHA-256 for) is a conflict and is never overwritten or deleted. R2 checks the
 * write against the SHA-256, so only bytes that hash to it are stored.
 */
export async function writeOnce(bucket: CloudR2, key: string, bytes: Uint8Array, sha256: string): Promise<WriteOnce> {
  try {
    const head = await bucket.head(key);
    if (head) return head.size === bytes.byteLength && hexOf(head.checksums.sha256) === sha256 ? 'present' : 'conflict';
    const put = await bucket.put(key, bytes, { sha256 });
    return put ? 'written' : 'conflict';
  } catch { return 'unreachable'; }
}
