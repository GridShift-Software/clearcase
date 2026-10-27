// Re-verification of a sealed run, for publish. The engine's finish proves coverage at the moment it seals; nothing in the schema stops a
// later insert of a new key, so a consumer of the root calls this first. It reads one snapshot and checks, without re-hashing any rows:
// the binding, that the run is complete, that the stored pages are contiguous, full except the last, and hash to the root, and that the
// stored item rows are exactly the pages' items with the greatest key the build ended on. A row added to the generation after completion
// changes the item count or the greatest key. A full recomputation from the rows is also possible (`pageBytes` and `rootBytes` define the
// forms) and is the independent check for a consumer that wants one; it costs hashing every row.
import { PAGE_SIZE, rootBytes } from './canonical.ts';
import { decodeCursor } from './cursor.ts';
import { sha256Hex } from './sha256.ts';
import type { EvidenceBinding, EvidenceStore } from './types.ts';

export type EvidenceVerification =
  | { readonly ok: true; readonly root: string; readonly items: number; readonly pages: number }
  | { readonly ok: false; readonly reason: 'not-complete' | 'binding-mismatch' | 'uncovered' };

export async function verifyEvidence(store: EvidenceStore, binding: EvidenceBinding): Promise<EvidenceVerification> {
  const facts = await store.inspect(binding);
  if (!facts || facts.state !== 'complete' || !facts.root) return { ok: false, reason: 'not-complete' };
  const { generation: _generation, candidateId: _candidate, ...bound } = binding;
  if ((Object.keys(bound) as (keyof typeof bound)[]).some(key => facts.binding[key] !== bound[key])) return { ok: false, reason: 'binding-mismatch' };
  const uncovered = { ok: false, reason: 'uncovered' } as const;
  let cursor;
  try { cursor = decodeCursor(facts.cursor); } catch { return uncovered; }
  const pages = [...facts.pages].sort((a, b) => a.number - b.number);
  if (!cursor.done || cursor.inPage !== 0 || cursor.pages !== pages.length) return uncovered;
  let items = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!, last = i === pages.length - 1;
    if (page.number !== i || (last ? page.itemCount < 1 : page.itemCount !== PAGE_SIZE) || page.itemCount > PAGE_SIZE) return uncovered;
    items += page.itemCount;
  }
  if (facts.itemCount !== items || facts.maxKey !== cursor.last) return uncovered;
  if (sha256Hex(rootBytes(pages.map(p => p.sha256))) !== facts.root) return uncovered;
  return { ok: true, root: facts.root, items, pages: pages.length };
}
