import { contractError } from '../../../server/runtime/errors.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import { verifiedRead, writeOnce } from '../../../storage/cloud/objects.ts';
import type { StagingStore } from './ports.ts';

const HEX = /^[0-9a-f]{64}$/;
/**
 * Keyed by operation, then by SHA-256: an import's staged objects are its own. Two imports of the same bytes write two objects, so the
 * sweep of one can never delete what another accepted, and a listing of an operation's prefix finds every object it wrote, rows or not.
 */
const PREFIX = 'native-import/';
const prefixOf = (a: { clientId: string; caseId: string; operationId: string }) =>
  `${PREFIX}${encodeURIComponent(a.clientId)}/${encodeURIComponent(a.caseId)}/${encodeURIComponent(a.operationId)}/`;
const keyOf = (a: { clientId: string; caseId: string; operationId: string; sha256: string }) => {
  if (!HEX.test(a.sha256)) throw contractError('integrity', false);
  return prefixOf(a) + a.sha256;
};
/** R2 lists at most 1,000 keys a call. */
const LIST_MAX = 1000;

/** The staged-bytes store over the deployment's private bucket. `maxBytes` is the import budget's `maxFileBytes`. */
export function r2StagingStore(bucket: CloudR2, o: { maxBytes?: number } = {}): StagingStore {
  const maxBytes = o.maxBytes ?? Number.MAX_SAFE_INTEGER;
  return {
    async put(a) {
      const written = await writeOnce(bucket, keyOf(a), a.bytes, a.sha256);
      if (written === 'unreachable') throw contractError('storage-unavailable', true);
      if (written === 'conflict') throw contractError('integrity', false);
      return written;
    },
    async delete(a) {
      const key = keyOf(a);
      // Staged keys are the only ones this store names; a candidate's package objects and the originals live under other prefixes.
      if (!key.startsWith(PREFIX) || typeof bucket.delete !== 'function') throw contractError('storage-unavailable', true);
      try { await bucket.delete(key); } catch { throw contractError('storage-unavailable', true); }
    },
    async list(a) {
      if (typeof bucket.list !== 'function' || !Number.isSafeInteger(a.limit) || a.limit < 1 || a.limit > LIST_MAX) throw contractError('storage-unavailable', true);
      const prefix = prefixOf(a);
      let page: Awaited<ReturnType<NonNullable<CloudR2['list']>>>;
      try { page = await bucket.list({ prefix, ...(a.after ? { startAfter: prefix + a.after } : {}), limit: a.limit }); } catch { throw contractError('storage-unavailable', true); }
      const names = page.objects.map((x) => x.key).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      return { names, more: page.truncated };
    },
    async read(a) {
      const r = await verifiedRead(bucket, keyOf(a), { size: a.size, sha256: a.sha256 }, maxBytes);
      if (r.kind === 'ok') return r.bytes;
      if (r.kind === 'missing') throw contractError('not-found', false);
      throw contractError(r.kind === 'unreachable' ? 'storage-unavailable' : 'integrity', r.kind === 'unreachable');
    },
  };
}
