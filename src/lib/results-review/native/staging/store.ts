import { contractError } from '../../../server/runtime/errors.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import { verifiedRead, writeOnce } from '../../../storage/cloud/objects.ts';
import type { StagingStore } from './ports.ts';

const HEX = /^[0-9a-f]{64}$/;
/** Content-addressed, per client and case. A retry under a new operation id reuses what an earlier one already staged. */
const PREFIX = 'native-import/';
const keyOf = (a: { clientId: string; caseId: string; sha256: string }) => {
  if (!HEX.test(a.sha256)) throw contractError('integrity', false);
  return `native-import/${encodeURIComponent(a.clientId)}/${encodeURIComponent(a.caseId)}/${a.sha256}`;
};

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
    async read(a) {
      const r = await verifiedRead(bucket, keyOf(a), { size: a.size, sha256: a.sha256 }, maxBytes);
      if (r.kind === 'ok') return r.bytes;
      throw contractError(r.kind === 'unreachable' ? 'storage-unavailable' : 'integrity', r.kind === 'unreachable');
    },
  };
}
