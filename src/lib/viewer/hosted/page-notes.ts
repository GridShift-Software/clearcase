// Page notes on an original: a person's written remark on one page of one acknowledged original, kept in user work
// (GLOSSARY: Note; "annotation" is avoided) through the injected AsyncUserWork, so it is durable, scoped to the case and
// survives a change of results version. Nothing is kept in the browser. The remark is stored as a register row of its own
// store; the original's SHA-256 at the time is recorded so a later change to the original is visible, never silent.
import type { AssetsAccess, AsyncUserWork, CaseId, Fields, Sha256, WorkVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';

export const PAGE_NOTE_STORE = 'original-page-notes';
export const MAX_PAGE = 100_000;
export const MAX_BODY = 2000;
type Work = Pick<AsyncUserWork, 'listRows' | 'putRow' | 'deleteRow'>;
export interface PageNote { rowId: string; assetId: string; page: number; body: string; version: WorkVersion; current: boolean }
export type PageNoteWrite = { kind: 'written'; note: PageNote } | { kind: 'stale' } | { kind: 'gone' };

const invalid = (): never => { throw contractError('invalid'); };
export function checkPageNote(a: { page: unknown; body: unknown }): { page: number; body: string } {
  const { page, body } = a;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) invalid();
  if (typeof body !== 'string') invalid();
  const text = (body as string).trim();
  if (!text || text.length > MAX_BODY || !text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)) invalid();
  return { page: page as number, body: text };
}

/** The original must be one the caller can read (and exist) before a note is listed or written against it. */
const describe = (assets: AssetsAccess, caseId: CaseId, assetId: string) => assets.metadata({ asset: { kind: 'original', caseId, assetId } });

export async function listPageNotes(a: { work: Work; assets: AssetsAccess; caseId: CaseId; assetId: string }): Promise<readonly PageNote[]> {
  const meta = await describe(a.assets, a.caseId, a.assetId);
  const rows = await a.work.listRows({ caseId: a.caseId, store: PAGE_NOTE_STORE });
  return rows
    .filter((r) => r.fields.assetId === a.assetId && typeof r.fields.page === 'number' && typeof r.fields.body === 'string')
    .map((r) => ({ rowId: r.rowId, assetId: a.assetId, page: r.fields.page as number, body: r.fields.body as string, version: r.version, current: r.fields.sha256 === meta.sha256 }))
    .sort((x, y) => x.page - y.page || (x.rowId < y.rowId ? -1 : 1));
}

export async function addPageNote(a: { work: Work; assets: AssetsAccess; caseId: CaseId; assetId: string; page: unknown; body: unknown; operationId: string }): Promise<PageNoteWrite> {
  const { page, body } = checkPageNote(a);
  const meta = await describe(a.assets, a.caseId, a.assetId);
  const fields: Fields = { assetId: a.assetId, page, body, sha256: meta.sha256 as Sha256 };
  const w = await a.work.putRow({ caseId: a.caseId, expected: { kind: 'absent' }, operationId: a.operationId, store: PAGE_NOTE_STORE, rowId: null, fields, anchor: null });
  return w.kind === 'written' ? { kind: 'written', note: { rowId: w.value.rowId, assetId: a.assetId, page, body, version: w.version, current: true } } : { kind: w.kind };
}

/** Removes one of this asset's own notes; a row of another original (or store) is never touched through this asset. */
export async function removePageNote(a: { work: Work; assets: AssetsAccess; caseId: CaseId; assetId: string; rowId: string; expected: WorkVersion; operationId: string }): Promise<'removed' | 'stale' | 'gone'> {
  await describe(a.assets, a.caseId, a.assetId);
  const own = (await a.work.listRows({ caseId: a.caseId, store: PAGE_NOTE_STORE })).find((r) => r.rowId === a.rowId && r.fields.assetId === a.assetId);
  if (!own) return 'gone';
  const w = await a.work.deleteRow({ caseId: a.caseId, expected: { kind: 'match', version: a.expected }, operationId: a.operationId, store: PAGE_NOTE_STORE, rowId: a.rowId });
  return w.kind === 'written' ? (w.value ? 'removed' : 'gone') : w.kind;
}
