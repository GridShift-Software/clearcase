// A published version's read model as immutable JSON shards (sprint ticket 06). The operator machine builds them
// (scripts/publish/), checks their bytes as it uploads them under `views/<rvHex>/` (never replacing an object), and
// admits their names in D1 at publication; the Worker only authorizes, then serves an admitted shard from the Cache API,
// or from R2 on a miss. Nothing is hashed on read: a shard's integrity is the manifest the sign-off bound, its R2 key is
// derived from the results version the caller has checked is the case's current published one, and an R2 object whose
// size is not the admitted one is refused and never cached.
import type { ClientId, ShardReader, VersionScope } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';

export const SHARD_CACHE_ORIGIN = 'https://shards.clearcase.internal';
export const SHARD_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const RV = /^sha256:[0-9a-f]{64}$/;
// `list/page-3.json`, `view/risk_matrix_tab.json`, `doc/<ref>.json`: segments that start with a letter or digit, so no
// segment is `.` or `..`.
const NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/){0,3}[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/;

export const shardPrefix = (resultsVersion: string) => `views/${resultsVersion.slice('sha256:'.length)}/`;
export const validShardName = (name: string) => NAME.test(name);

/** The R2 object a shard is read from: the Workers binding's `get`, or a double with the same body accessors. */
export interface ShardObject { arrayBuffer(): Promise<ArrayBuffer>; etag: string; httpEtag?: string }
export interface ShardBucket { get(key: string): Promise<ShardObject | null> }
/** The Cache API's `caches.default`, or a double. */
export interface ShardCache { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void> }

export function createShardReader(o: { bucket: ShardBucket; clientId: ClientId; cache: ShardCache | null; waitUntil?: (work: Promise<unknown>) => void }): ShardReader {
  return {
    async read({ caseId, resultsVersion, name, bytes: expected }: VersionScope & { name: string; bytes: number }) {
      if (!RV.test(resultsVersion) || !validShardName(name)) return null;
      const prefix = shardPrefix(resultsVersion);
      const key = `${SHARD_CACHE_ORIGIN}/${encodeURIComponent(o.clientId)}/${encodeURIComponent(caseId)}/${prefix.slice('views/'.length)}${name}`;
      const hit = o.cache ? await o.cache.match(key).catch(() => undefined) : undefined;
      if (hit) return hit;
      let object: ShardObject | null, bytes: ArrayBuffer;
      try {
        object = await o.bucket.get(prefix + name);
        if (!object) return null;
        bytes = await object.arrayBuffer();
      } catch { throw contractError('storage-unavailable', true); }
      if (bytes.byteLength !== expected) throw contractError('storage-unavailable', true);
      const response = new Response(bytes, { headers: { 'content-type': 'application/json', 'cache-control': SHARD_CACHE_CONTROL, etag: object.httpEtag ?? `"${object.etag}"` } });
      if (o.cache) {
        const put = o.cache.put(key, response.clone()).catch(() => undefined);
        if (o.waitUntil) o.waitUntil(put); else await put;
      }
      return response;
    },
  };
}

/** `caches.default` where the runtime has the Cache API (Workers, workerd), else null. */
export function defaultShardCache(): ShardCache | null {
  const c = (globalThis as { caches?: { default?: { match(k: string): Promise<Response | undefined>; put(k: string, r: Response): Promise<void> } } }).caches?.default;
  return c ? { match: (k) => c.match(k), put: (k, r) => c.put(k, r) } : null;
}
