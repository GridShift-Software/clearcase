// Originals evidence for a v2 candidate (real-export design 2; U8). Hosted-safe: two ports over R2 and nothing else.
//
//   originalRefs               the case's finalized originals that the package's file assets name, as ordered refs (asset id, sha256, size).
//   createOriginalsProducer    U3's `EvidenceProducer`: one `original/<assetId>` observation per ref, each with the sha256 it hashed, the size
//                              it read and the etag R2 gave on that same read. A batch of originals is read and hashed together, bounded
//                              by a count and by bytes held in memory.
//   r2OriginalsComparison      the publish-time side (`signoff-evidence.ts`): `head` per object in batches, never a body.
//
// A producer may be called again for the item a step left at its byte bound, and a restarted build calls it for the item after its
// cursor. Both are the same pure read of the same refs, and the producer writes nothing, so neither repeats a row: the engine commits
// rows and cursor together, and migration 0005's seals make a second insert of a key an error, so nothing here inserts or ignores.
//
// Cost. A step reads `itemsPerStep` originals at most, `batch` at a time, and holds at most `windowBytes` of them. Wall time is the R2 latency
// of ceil(itemsPerStep / batch) rounds plus about a millisecond per MiB hashed; R2 reads are subrequests, one per distinct object. Size
// `itemsPerStep` and `batch` from the account's measured limits (Workers Paid, U1), not from Workers Free's 10 ms. A step never samples:
// an original that cannot be read and hashed stops the build (`OriginalsEvidenceError`), because a run without it would not cover it.
import { digest } from '../../server/runtime/data.ts';
import type { CloudR2 } from '../../storage/cloud/bindings.ts';
import { originalKey } from '../../storage/cloud/keys.ts';
import type { EvidenceProducer } from './evidence/index.ts';
import type { OriginalHead, OriginalsComparison } from './signoff-evidence.ts';

/** One original the evidence covers. The object is `orig/<sha256>` (content-addressed, write-once). */
export interface OriginalRef { readonly assetId: string; readonly sha256: string; readonly size: number }

export type OriginalsEvidenceFailure = 'invalid-ref' | 'refs-changed' | 'missing' | 'size-mismatch' | 'content-mismatch' | 'over-budget' | 'storage-unavailable';
/** Why no observation was produced for an original. Retryable only for `storage-unavailable`; the rest need the original or the refs fixed. */
export class OriginalsEvidenceError extends Error {
  readonly code: OriginalsEvidenceFailure;
  readonly assetId: string | null;
  constructor(code: OriginalsEvidenceFailure, assetId: string | null) {
    super(assetId === null ? `originals evidence: ${code}` : `originals evidence: ${code} (${assetId})`);
    this.name = 'OriginalsEvidenceError'; this.code = code; this.assetId = assetId;
  }
}

const HEX = /^[0-9a-f]{64}$/;
/** Item keys are `original/<assetId>` and an evidence key admits `[A-Za-z0-9._:/-]` up to 200 characters. An asset id here has no `/`. */
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The folder fields `originalRefs` reads: what `caseFolder` (original-facts.ts) returns for each finalized original. */
export interface FolderOriginalFields { readonly assetId: string; readonly sha256: string; readonly size: number; readonly originalSize: number; readonly objectKey: string }

/**
 * The refs for a candidate: every folder original whose sha256 one of the package's file assets names, ascending by asset id, one per asset.
 * An asset the folder does not hold (an original not supplied) has no ref; that is U10's policy, not this unit's. A folder original whose
 * recorded size disagrees with its object, whose object is not under its content key, or an asset id that appears with two sets of
 * bytes, is refused rather than skipped.
 */
export function originalRefs(folder: readonly FolderOriginalFields[], assets: readonly { readonly sha256: string }[]): OriginalRef[] {
  const wanted = new Set(assets.map(a => a.sha256)), byAsset = new Map<string, OriginalRef>();
  for (const o of folder) {
    if (!wanted.has(o.sha256)) continue;
    if (!ASSET_ID.test(o.assetId) || !HEX.test(o.sha256) || !Number.isSafeInteger(o.size) || o.size < 0 || o.originalSize !== o.size || o.objectKey !== originalKey(o.sha256)) throw new OriginalsEvidenceError('invalid-ref', o.assetId);
    const known = byAsset.get(o.assetId);
    if (known && (known.sha256 !== o.sha256 || known.size !== o.size)) throw new OriginalsEvidenceError('invalid-ref', o.assetId);
    byAsset.set(o.assetId, { assetId: o.assetId, sha256: o.sha256, size: o.size });
  }
  return [...byAsset.values()].sort((x, y) => compare(x.assetId, y.assetId));
}

export interface OriginalsProducerOptions {
  /** The refs, ascending by asset id with no repeat. Called once per producer; a build that resumes calls it again and must get the same refs. */
  readonly refs: () => Promise<readonly OriginalRef[]>;
  readonly bucket: Pick<CloudR2, 'get'>;
  /** Originals read and hashed together. Keep it no larger than the engine's `itemsPerStep`, or a step reads ahead of what it commits. */
  readonly batch: number;
  /** Most original bytes held in memory at once; a batch stops growing when the next original would pass it (one original always fits). */
  readonly windowBytes: number;
  /** Largest single original it will buffer and hash (the storage budget `maxBufferedObjectBytes`); a larger one is `over-budget`. */
  readonly maxObjectBytes: number;
}
interface Observed { readonly sha256: string; readonly size: number; readonly etag: string }

export function createOriginalsProducer(options: OriginalsProducerOptions): EvidenceProducer {
  const { bucket, batch, windowBytes, maxObjectBytes } = options;
  if (!Number.isInteger(batch) || batch < 1) throw new RangeError('batch must be a positive integer');
  if (!Number.isSafeInteger(windowBytes) || windowBytes < 1 || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) throw new RangeError('windowBytes and maxObjectBytes must be positive integers');
  let loaded: Promise<{ refs: readonly OriginalRef[]; at: Map<string, number> }> | null = null;
  const window = new Map<number, Observed>();

  const load = () => loaded ??= options.refs().then(refs => {
    const at = new Map<string, number>();
    refs.forEach((ref, i) => {
      if (!ASSET_ID.test(ref.assetId) || !HEX.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0 || at.has(ref.assetId) || (i > 0 && compare(refs[i - 1]!.assetId, ref.assetId) >= 0)) throw new OriginalsEvidenceError('invalid-ref', ref.assetId);
      at.set(ref.assetId, i);
    });
    return { refs, at };
  }).catch(error => { loaded = null; throw error; });

  /** Read and hash one original: the bytes, size and etag of a single `get`, checked against the ref. Never returns a fact the ref does not hold. */
  async function observe(ref: OriginalRef): Promise<Observed> {
    if (ref.size > maxObjectBytes) throw new OriginalsEvidenceError('over-budget', ref.assetId);
    let object: Awaited<ReturnType<CloudR2['get']>>;
    try { object = await bucket.get(originalKey(ref.sha256)); } catch { throw new OriginalsEvidenceError('storage-unavailable', ref.assetId); }
    if (!object) throw new OriginalsEvidenceError('missing', ref.assetId);
    if (object.size !== ref.size) throw new OriginalsEvidenceError('size-mismatch', ref.assetId);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await object.arrayBuffer()); } catch { throw new OriginalsEvidenceError('storage-unavailable', ref.assetId); }
    if (bytes.byteLength !== ref.size) throw new OriginalsEvidenceError('size-mismatch', ref.assetId);
    if (await digest(bytes) !== ref.sha256) throw new OriginalsEvidenceError('content-mismatch', ref.assetId);
    return { sha256: ref.sha256, size: bytes.byteLength, etag: object.etag };
  }

  /** Fill the window from `from`: up to `batch` originals, as many as fit `windowBytes`, each distinct object read once. */
  async function fill(refs: readonly OriginalRef[], from: number) {
    window.clear();
    const picked: number[] = [], seen = new Set<string>();
    let held = 0;
    for (let i = from; i < refs.length && picked.length < batch; i++) {
      const ref = refs[i]!;
      if (!seen.has(ref.sha256)) {
        if (picked.length > 0 && held + ref.size > windowBytes) break;
        seen.add(ref.sha256); held += ref.size;
      }
      picked.push(i);
    }
    const reads = new Map<string, Promise<Observed>>();
    for (const i of picked) { const ref = refs[i]!; if (!reads.has(ref.sha256)) reads.set(ref.sha256, observe(ref)); }
    const results = await Promise.all(picked.map(i => reads.get(refs[i]!.sha256)!));
    picked.forEach((i, n) => {
      // Assets that share an object share what was read; each must still have declared exactly that many bytes.
      if (results[n]!.size !== refs[i]!.size) throw new OriginalsEvidenceError('size-mismatch', refs[i]!.assetId);
      window.set(i, results[n]!);
    });
  }

  return async cursor => {
    const { refs, at } = await load();
    let index = 0;
    if (cursor !== null) {
      const last = at.get(cursor);
      // The refs are not the ones the build began with: the run cannot be continued, only started again under a new generation.
      if (last === undefined) throw new OriginalsEvidenceError('refs-changed', cursor);
      index = last + 1;
    }
    const ref = refs[index];
    if (!ref) return { done: true };
    if (!window.has(index)) await fill(refs, index);
    const seen = window.get(index)!;
    window.delete(index);
    return { done: false, nextCursor: ref.assetId, key: `original/${ref.assetId}`, observation: { kind: 'original', assetId: ref.assetId, sha256: seen.sha256, size: seen.size, etag: seen.etag } };
  };
}

export interface R2ComparisonOptions { readonly batch: number; readonly limit: number }
/**
 * Publish's side over a bucket: `head` each object of a batch together and report its current etag and size. A `head` that throws makes the
 * whole call reject (503 upstream); it is never read as "missing". `batch` bounds the concurrent R2 calls and `limit` the subrequests one
 * recheck spends on originals.
 */
export function r2OriginalsComparison(bucket: Pick<CloudR2, 'head'>, options: R2ComparisonOptions): OriginalsComparison {
  const { batch, limit } = options;
  if (!Number.isInteger(batch) || batch < 1 || !Number.isInteger(limit) || limit < 1) throw new RangeError('batch and limit must be positive integers');
  return {
    batch, limit,
    heads: keys => Promise.all(keys.map(async (key): Promise<OriginalHead | null> => {
      const head = await bucket.head(key);
      return head ? { etag: head.etag, size: head.size } : null;
    })),
  };
}
