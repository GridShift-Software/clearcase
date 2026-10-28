// Contract diagnostics and unit tests only: the shard reader over an in-memory bucket and cache. No production entry imports it.
import { createShardReader, type ShardBucket, type ShardCache } from '../../results/hosted/shards.ts';
import type { ClientId, ShardReader } from './contracts.ts';

/** Objects by R2 key (`views/<rvHex>/<name>`). */
export function memoryShardBucket(objects: Map<string, Uint8Array> = new Map()): ShardBucket & { objects: Map<string, Uint8Array> } {
  return {
    objects,
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const copy = new Uint8Array(bytes);
      return { etag: `m${copy.byteLength}`, httpEtag: `"m${copy.byteLength}"`, arrayBuffer: async () => copy.buffer };
    },
  };
}

export function memoryShardCache(): ShardCache & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(key) { return entries.get(key)?.clone(); },
    async put(key, response) { entries.set(key, response.clone()); },
  };
}

export function createMemoryShards(a: { clientId: ClientId; bucket?: ShardBucket; cache?: ShardCache | null }): ShardReader {
  return createShardReader({ bucket: a.bucket ?? memoryShardBucket(), clientId: a.clientId, cache: a.cache === undefined ? memoryShardCache() : a.cache });
}
