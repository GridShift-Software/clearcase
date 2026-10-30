// Page notes (a person's note on one page of an original, written in the original's viewer) as the case notes list and a
// document's My notes show them. They are rows of the viewer's own user-work store, read here and never written: each row
// stays exactly as the viewer saved it, and the viewer is where one is changed or deleted, so every item links back there.
// An original is its bytes: R2 keeps it once per SHA-256 (rs_original), and an asset id is only the name one import bound
// it to. A page note therefore shows on every document, in any results version, whose original has the SHA-256 it was
// written on, and on no other document.
import type { CaseId, Versioned, WorkRegisterRow } from '../../server/runtime/contracts.ts';
import { MAX_BODY, MAX_PAGE, PAGE_NOTE_STORE } from '../../viewer/hosted/page-notes.ts';
import { originalHref } from './paths.ts';

export { PAGE_NOTE_STORE };

export interface PageNoteItem {
  rowId: string;
  version: string;
  /** the asset id the original had when the note was written; links back to its viewer */
  assetId: string;
  page: number;
  body: string;
  /** when the viewer saved the note (the row's own time, never invented) */
  createdAt: string;
  /** the original's SHA-256 when the note was written */
  sha256: string;
  /** false when the stored row no longer matches the digest it was saved with */
  intact: boolean;
  /** the original's viewer, open at this page */
  href: string;
}
/** A document's page note: `here` is false when the same bytes were written on under another asset id. */
export type DocumentPageNote = PageNoteItem & { here: boolean };
/** The page notes a list can show, and how many stored rows are not readable page notes (counted, never hidden silently). */
export interface PageNotes { items: PageNoteItem[]; unreadable: number }

const SHA256 = /^[0-9a-f]{64}$/;

function itemOf(caseId: CaseId, r: Versioned<WorkRegisterRow>): PageNoteItem | null {
  const { assetId, page, body, sha256 } = r.fields;
  if (r.store !== PAGE_NOTE_STORE || typeof assetId !== 'string' || !assetId || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) return null;
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) return null;
  return { rowId: r.rowId, version: r.version, assetId, page, body, createdAt: r.createdAt, sha256, intact: r.intact,
    href: `${originalHref(caseId, assetId)}/view?page=${page}` };
}

/** Every readable page note of the case, newest first, as the case notes list orders its notes. */
export function pageNotes(caseId: CaseId, rows: readonly Versioned<WorkRegisterRow>[]): PageNotes {
  const items: PageNoteItem[] = [];
  for (const r of rows) { const item = itemOf(caseId, r); if (item) items.push(item); }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.rowId < b.rowId ? -1 : 1));
  return { items, unreadable: rows.length - items.length };
}

/**
 * The page notes of one document: those written on its original's bytes, by page. A document without an original of its
 * own (none supplied, or inside its parent message) has none.
 */
export function documentPageNotes(notes: PageNotes, original: { sha256: string | null; assetId: string | null }): DocumentPageNote[] {
  if (!original.sha256) return [];
  return notes.items.filter((n) => n.sha256 === original.sha256)
    .map((n) => ({ ...n, here: n.assetId === original.assetId }))
    .sort((a, b) => a.page - b.page || (a.rowId < b.rowId ? -1 : 1));
}
