// TEST DOUBLE (hosted-gate profile only): see ./services.ts. The gate's synthetic fixture has no published shards, so the
// reader runs over the gate's local bucket without the Cache API and answers null for every shard it does not hold.
import { createShardReader, type ShardBucket } from '../../../../results/hosted/shards.ts';
import type { ClientId, ShardReader } from '../../contracts.ts';

export function fixtureShards(a: { bucket: ShardBucket; clientId: ClientId }): ShardReader {
	return createShardReader({ bucket: a.bucket, clientId: a.clientId, cache: null });
}
