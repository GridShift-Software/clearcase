// The build cursor (stored opaque in pub_evidence_run.cursor, canonical JSON): the producer's cursor, the last key written, the sealed
// page count, the rows in the open page, whether the producer is exhausted, and the open page's SHA-256 state. A finished run keeps its
// final cursor, so a verifier can read the sealed page count and the last key from it.
import { PAGE_SIZE, PAGE_TAG, canonicalJson, utf8 } from './canonical.ts';
import { Sha256, type Sha256Snapshot } from './sha256.ts';

export interface Cursor { readonly producer: string | null; readonly last: string | null; readonly pages: number; readonly inPage: number; readonly done: boolean; readonly hash: Sha256Snapshot }

export const initialCursor = (): Cursor => ({ producer: null, last: null, pages: 0, inPage: 0, done: false, hash: new Sha256().update(utf8(PAGE_TAG)).snapshot() });
export const encodeCursor = (c: Cursor) => canonicalJson({ v: 1, producer: c.producer, last: c.last, pages: c.pages, inPage: c.inPage, done: c.done, hash: { h: c.hash.h, buffer: c.hash.buffer, length: c.hash.length } });
export function decodeCursor(text: string | null): Cursor {
  if (text === null) return initialCursor();
  const v = JSON.parse(text) as Record<string, unknown>;
  const ok = v.v === 1 && (v.producer === null || typeof v.producer === 'string') && (v.last === null || typeof v.last === 'string') && Number.isSafeInteger(v.pages)
    && Number.isSafeInteger(v.inPage) && (v.inPage as number) >= 0 && (v.inPage as number) < PAGE_SIZE && typeof v.done === 'boolean' && typeof v.hash === 'object' && v.hash !== null;
  if (!ok) throw new Error('evidence cursor is malformed');
  return v as unknown as Cursor;
}
