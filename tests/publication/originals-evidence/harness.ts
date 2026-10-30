// Synthetic only. A MemoryR2 holding content-addressed originals, U8's producer feeding U3's real engine inside U5's world (real native
// schema, real controller, ledger and publisher over node:sqlite). This is SQLite and an in-memory R2, not Cloudflare D1 or R2.
import { createHash } from 'node:crypto';
import type { EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { createOriginalsProducer, r2OriginalsComparison, type OriginalRef } from '../../../src/lib/publication/hosted/originals-evidence.ts';
import { observations, type Spec } from '../readiness-v2/harness.ts';
import { world, type Options } from '../signoff-root/harness.ts';
import { MemoryR2 } from '../../hosted-foundation/storage/doubles.ts';

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** `size` deterministic bytes that differ per `seed`. */
export const bytesOf = (seed: number, size = 64) => Uint8Array.from({ length: size }, (_, i) => (seed * 31 + i * 7 + (i >> 3)) & 0xff);

export interface Seeded { r2: MemoryR2; refs: OriginalRef[]; keyOf(ref: OriginalRef): string }
/** `count` originals, `orig/<sha256>` each, asset ids `sub-op-00000` upward (ascending, as the producer requires). */
export async function seed(count: number, size = 64): Promise<Seeded> {
  const r2 = new MemoryR2(), refs: OriginalRef[] = [];
  for (let n = 0; n < count; n++) {
    const bytes = bytesOf(n + 1, size + (n % 5)), hash = sha(bytes);
    await r2.put(`orig/${hash}`, bytes, { sha256: hash });
    refs.push({ assetId: `sub-op-${String(n).padStart(5, '0')}`, sha256: hash, size: bytes.byteLength });
  }
  return { r2, refs, keyOf: ref => `orig/${ref.sha256}` };
}

/** Originals first (`original/` sorts after `error/` and before `preview/`), then the rest of the observations in key order. */
export function sequence(first: EvidenceProducer, rest: ReturnType<typeof observations>): EvidenceProducer {
  return async cursor => {
    if (cursor === null || cursor.startsWith('o:')) {
      const r = await first(cursor === null ? null : cursor.slice(2));
      if (!r.done) return { ...r, nextCursor: `o:${r.nextCursor}` };
      cursor = null;
    }
    const n = cursor === null ? 0 : Number(cursor.slice(2)), item = rest[n];
    return item ? { done: false, nextCursor: `p:${n + 1}`, key: item.key, observation: item.observation } : { done: true };
  };
}

export interface OriginalsOptions extends Options { count?: number; size?: number; batch?: number; limit?: number }
/** A candidate whose evidence run holds one `original/` item per seeded original, read from R2 by the producer. */
export async function originalsWorld(options: OriginalsOptions = {}) {
  const seeded = await seed(options.count ?? 12, options.size);
  const spec: Spec = options.spec ?? { previews: 6, warnings: 8 };
  const heads: string[][] = [];
  const compare = r2OriginalsComparison({ head: key => seeded.r2.head(key) }, { batch: options.batch ?? 4, limit: options.limit ?? 1000 });
  const comparison = { ...compare, heads: async (keys: readonly string[]) => { heads.push([...keys]); return compare.heads(keys); } };
  const producer = sequence(createOriginalsProducer({ refs: async () => seeded.refs, bucket: seeded.r2, batch: 4, windowBytes: 1 << 20, maxObjectBytes: 1 << 20 }), observations(spec));
  const w = await world({ baseline: 3, ...options, spec, producer, originals: options.originals ?? comparison });
  return { ...w, ...seeded, heads, comparison };
}
export type OriginalsWorld = Awaited<ReturnType<typeof originalsWorld>>;
