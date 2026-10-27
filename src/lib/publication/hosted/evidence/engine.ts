// Resumable, bounded evidence build (design 2). Pure orchestration over four ports: the observation producer, the clock, the
// lease id and the store. One step claims the lease, writes at most `itemsPerStep` rows and `bytesPerStep` bytes in one atomic
// commit, and returns. A killed step leaves the previous commit intact; the next step resumes from the stored cursor.
//
// The cursor (cursor.ts) carries the open page's SHA-256 state. Because the digest is incremental, each row is hashed once, when
// written, and no step re-reads rows. Finishing is conditional on the stored rows being exactly what the root covers, and a complete
// run is answered only after `verifyEvidence` agrees it still does.
import { PAGE_SIZE, PAGE_TAG, KEY_PATTERN, canonicalJson, rootBytes, rowText, utf8 } from './canonical.ts';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.ts';
import { Sha256, sha256Hex } from './sha256.ts';
import { verifyEvidence } from './verify.ts';
import { MAX_BYTES_PER_STEP, MAX_ITEMS_PER_STEP, type EvidenceBinding, type EvidenceBounds, type EvidencePage, type EvidenceProducer, type EvidenceRefusal, type EvidenceStepResult, type EvidenceStore } from './types.ts';

export interface EvidenceEngineOptions {
  readonly binding: EvidenceBinding;
  readonly store: EvidenceStore;
  readonly producer: EvidenceProducer;
  /** Milliseconds since an epoch shared by every builder. */
  readonly clock: () => number;
  /** Identifies this builder. Two live builders must not share one, and a restarted builder takes a fresh id. */
  readonly leaseId: string;
  /** How long a claim or commit keeps the lease. A step must finish, or lose the lease, within this time. */
  readonly leaseMs: number;
  readonly bounds: EvidenceBounds;
}
export interface EvidenceEngine { step(): Promise<EvidenceStepResult> }

interface Built { readonly kind: 'built'; readonly next: Cursor; readonly items: { key: string; json: string }[]; readonly page: EvidencePage | null }

function checked(options: EvidenceEngineOptions) {
  const { bounds, leaseMs } = options;
  if (!Number.isInteger(bounds.itemsPerStep) || bounds.itemsPerStep < 1 || bounds.itemsPerStep > MAX_ITEMS_PER_STEP) throw new RangeError('itemsPerStep must be an integer from 1 to 500');
  if (!Number.isInteger(bounds.bytesPerStep) || bounds.bytesPerStep < 1 || bounds.bytesPerStep > MAX_BYTES_PER_STEP) throw new RangeError('bytesPerStep must be an integer from 1 to 1 MiB');
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new RangeError('leaseMs must be a positive integer');
  if (!options.leaseId) throw new RangeError('leaseId must not be empty');
  for (const [name, value] of Object.entries(options.binding)) if (typeof value !== 'string' || value === '') throw new RangeError(`binding.${name} must be a non-empty string`);
}

export function createEvidenceEngine(options: EvidenceEngineOptions): EvidenceEngine {
  checked(options);
  const { binding, store, producer, clock, leaseId, leaseMs, bounds } = options;
  const input = { caseId: binding.caseId, clientId: binding.clientId, manifestSha256: binding.manifestSha256, rendererVersion: binding.rendererVersion,
    resultsVersion: binding.resultsVersion, validatorVersion: binding.validatorVersion };

  async function produce(cursor: Cursor, hash: Sha256): Promise<Built | { kind: 'refused'; reason: EvidenceRefusal }> {
    const items: { key: string; json: string }[] = [];
    let { producer: position, last, pages, inPage, done } = cursor;
    let bytes = 0, page: EvidencePage | null = null;
    while (items.length < bounds.itemsPerStep && !done && page === null) {
      const next = await producer(position);
      if (next.done) { done = true; break; }
      if (typeof next.key !== 'string' || !KEY_PATTERN.test(next.key)) return { kind: 'refused', reason: 'invalid-key' };
      if (last !== null && next.key <= last) return { kind: 'refused', reason: 'key-order' };
      let json: string;
      try { json = canonicalJson({ input, observation: next.observation }); } catch (error) { if (error instanceof RangeError) return { kind: 'refused', reason: 'invalid-observation' }; throw error; }
      const row = utf8(rowText(next.key, json));
      if (row.length > bounds.bytesPerStep) return { kind: 'refused', reason: 'item-too-large' };
      // The item that would cross the byte bound is left for the next step. Its producer call is repeated there.
      if (bytes + row.length > bounds.bytesPerStep) break;
      hash.update(row);
      items.push({ key: next.key, json });
      bytes += row.length; position = next.nextCursor; last = next.key; inPage++;
      if (inPage === PAGE_SIZE) { page = { number: pages, sha256: hash.digestHex(), itemCount: PAGE_SIZE }; pages++; inPage = 0; hash = new Sha256().update(utf8(PAGE_TAG)); }
    }
    return { kind: 'built', next: { producer: position, last, pages, inPage, done, hash: hash.snapshot() }, items, page };
  }

  return {
    async step() {
      const now = clock();
      const claim = await store.claim(binding, leaseId, now, now + leaseMs);
      if (claim.kind === 'complete') {
        const verified = await verifyEvidence(store, binding);
        return verified.ok ? { kind: 'complete', root: verified.root } : { kind: 'refused', reason: verified.reason === 'binding-mismatch' ? 'binding-mismatch' : 'coverage' };
      }
      if (claim.kind === 'leased') return { kind: 'leased' };
      if (claim.kind === 'binding-mismatch') return { kind: 'refused', reason: 'binding-mismatch' };
      const cursor = decodeCursor(claim.cursor);
      const expect = { cursor: claim.cursor };

      if (cursor.done) {
        const digests = await store.pages(binding);
        let page: EvidencePage | null = null;
        if (cursor.inPage > 0) { page = { number: cursor.pages, sha256: Sha256.restore(cursor.hash).digestHex(), itemCount: cursor.inPage }; digests.push(page.sha256); }
        if (digests.length !== cursor.pages + (page ? 1 : 0)) return { kind: 'refused', reason: 'coverage' };
        const root = sha256Hex(rootBytes(digests));
        const sealed = await store.finish(binding, leaseId, expect, { page, root, digests, items: cursor.pages * PAGE_SIZE + cursor.inPage, lastKey: cursor.last, nowMs: clock(),
          nextCursor: encodeCursor({ ...cursor, pages: cursor.pages + (page ? 1 : 0), inPage: 0 }) });
        return sealed === 'sealed' ? { kind: 'complete', root } : sealed === 'lost' ? { kind: 'leased' } : { kind: 'refused', reason: 'coverage' };
      }

      const built = await produce(cursor, Sha256.restore(cursor.hash));
      if (built.kind === 'refused') return built;
      const { next, items, page } = built;
      const at = clock();
      const written = await store.commit(binding, leaseId, expect, { items, page, nextCursor: encodeCursor(next), leaseUntilMs: at + leaseMs, nowMs: at });
      return written ? { kind: 'progress', items: items.length } : { kind: 'leased' };
    },
  };
}
