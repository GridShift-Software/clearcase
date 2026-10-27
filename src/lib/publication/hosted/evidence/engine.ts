// Resumable, bounded evidence build (design 2). Pure orchestration over four ports: the observation producer, the clock, the
// lease id and the store. One step claims the lease, writes at most `itemsPerStep` rows and `bytesPerStep` bytes in one atomic
// commit, and returns. A killed step leaves the previous commit intact; the next step resumes from the stored cursor.
//
// Cursor (stored opaque in pub_evidence_run.cursor, canonical JSON): the producer's cursor, the last key written, the sealed page
// count, the rows in the open page, whether the producer is exhausted, and the open page's SHA-256 state. Because the digest is
// incremental, each row is hashed once, when written, and no step re-reads rows.
import { PAGE_SIZE, PAGE_TAG, KEY_PATTERN, canonicalJson, rootBytes, rowText, utf8 } from './canonical.ts';
import { Sha256, sha256Hex, type Sha256Snapshot } from './sha256.ts';
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
interface Cursor { readonly producer: string | null; readonly last: string | null; readonly pages: number; readonly inPage: number; readonly done: boolean; readonly hash: Sha256Snapshot }

const initialCursor = (): Cursor => ({ producer: null, last: null, pages: 0, inPage: 0, done: false, hash: new Sha256().update(utf8(PAGE_TAG)).snapshot() });
const encodeCursor = (c: Cursor) => canonicalJson({ v: 1, producer: c.producer, last: c.last, pages: c.pages, inPage: c.inPage, done: c.done, hash: { h: c.hash.h, buffer: c.hash.buffer, length: c.hash.length } });
function decodeCursor(text: string | null): Cursor {
  if (text === null) return initialCursor();
  const v = JSON.parse(text) as Record<string, unknown>;
  const ok = v.v === 1 && (v.producer === null || typeof v.producer === 'string') && (v.last === null || typeof v.last === 'string') && Number.isSafeInteger(v.pages)
    && Number.isSafeInteger(v.inPage) && (v.inPage as number) >= 0 && (v.inPage as number) < PAGE_SIZE && typeof v.done === 'boolean' && typeof v.hash === 'object' && v.hash !== null;
  if (!ok) throw new Error('evidence cursor is malformed');
  return v as unknown as Cursor;
}

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
      if (claim.kind === 'complete') return { kind: 'complete', root: claim.root };
      if (claim.kind === 'leased') return { kind: 'leased' };
      if (claim.kind === 'binding-mismatch') return { kind: 'refused', reason: 'binding-mismatch' };
      const cursor = decodeCursor(claim.cursor);
      const expect = { cursor: claim.cursor };

      if (cursor.done) {
        const digests = await store.pages(binding);
        let page: EvidencePage | null = null;
        if (cursor.inPage > 0) { page = { number: cursor.pages, sha256: Sha256.restore(cursor.hash).digestHex(), itemCount: cursor.inPage }; digests.push(page.sha256); }
        if (digests.length !== cursor.pages + (page ? 1 : 0)) throw new Error('evidence pages disagree with the cursor');
        const root = sha256Hex(rootBytes(digests));
        const sealed = await store.finish(binding, leaseId, expect, { page, root, nextCursor: encodeCursor({ ...cursor, pages: cursor.pages + (page ? 1 : 0), inPage: 0 }) });
        return sealed ? { kind: 'complete', root } : { kind: 'leased' };
      }

      const built = await produce(cursor, Sha256.restore(cursor.hash));
      if (built.kind === 'refused') return built;
      const { next, items, page } = built;
      const written = await store.commit(binding, leaseId, expect, { items, page, nextCursor: encodeCursor(next), leaseUntilMs: clock() + leaseMs });
      return written ? { kind: 'progress', items: items.length } : { kind: 'leased' };
    },
  };
}
