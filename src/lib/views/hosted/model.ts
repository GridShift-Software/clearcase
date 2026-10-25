// The hosted case views' page data, shared by the server loads and the pages. Types only.
import type { ChronologyListRow, OverviewModel, ResultsVersion } from './types.ts';
import type { ChronologyQuery } from '../../local-case/chronology.ts';

export interface OverviewData {
  resultsVersion: ResultsVersion; caseName: string; subtitle: string | null; matterTitle: string | null; producer: string; created: string; inputKind: string;
  documents: { total: number; imported: number; provided: number; failed: { source: string; owner: string; reason: string }[] };
  counts: { emails: number; invoices: number; attachments: number; withoutText: number };
  dates: OverviewModel['dates']; originals: OverviewModel['originals'];
  tallies: { byBundle: [string, number][]; byDocType: [string, number][]; byTextStatus: [string, number][] };
  chronologyHref: string; notesHref: string;
}

export interface ChronologyItem {
  ref: string; date: string; docType: string; bundle: string; title: string; sender: string; excerpt: string; amount: string; textStatus: string; parentRef: string | null; file: ChronologyListRow['file'];
  /** the authorized case original resolved through the immutable path/fingerprint mapping; never a guessed asset */
  originalHref: string | null; originalAssetId: string | null;
}
export interface ChronologyData {
  resultsVersion: ResultsVersion; total: number; items: ChronologyItem[]; query: ChronologyQuery; search: string;
  options: { bundles: string[]; types: string[]; statuses: string[] }; failed: { source: string; owner: string; reason: string }[]; originals: 'available' | 'unavailable';
}

export interface NoteItem { id: string; version: string; body: string; createdAt: string; target: { kind: 'case' } | { kind: 'document'; ref: string; resultsVersion: string } | { kind: 'analysis'; section: string } }
/** What a refused save hands back to the form: the user's own text, and the server's state where it moved on. */
export interface NoteRefusal {
  op: 'add' | 'delete'; message: string; body?: string; ref?: string; resultsVersion?: string; current?: NoteItem | null; notes?: NoteItem[];
  /** A valid submitted retry identity is retained; an unknown write outcome must never become a second write. */
  operationId?: string;
}
