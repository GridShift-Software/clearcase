// The user's own notes on a case, through AsyncUserWork only: a note on the case itself, or an annotation on a document
// of the case's current published version. Each write carries the operation id the form was rendered with, so a
// resubmitted form is one write, and a delete carries the version the user saw. A stale or vanished target answers 409
// with the user's text kept and the server's current version, so nothing typed is lost and nothing is overwritten. A
// delete runs only once confirmed for that note (GRS-280). No state is kept in the browser or in memory here: a note
// exists once AsyncUserWork answers `written`.
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { CaseId, CaseInfo, HostedNote, NoteTarget, RequestServices, ResultsVersion, Versioned } from './types.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { canWriteWork, currentVersion, part, readCase } from './case.server.ts';
import { caseHref, chronologyHref, notesHref } from './paths.ts';
import { deleteStep } from '../../components/confirm-delete.ts';
import type { NoteItem, NoteRefusal } from './model.ts';
import { PAGE_NOTE_STORE, pageNotes, type PageNotes } from './page-note-items.ts';

export type { NoteItem, NoteRefusal };

export const MAX_NOTE = 20_000;
const OPERATION = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const item = (n: Versioned<HostedNote>): NoteItem => ({
  id: n.id, version: n.version, body: n.body, createdAt: n.createdAt,
  target: n.target.kind === 'case' ? { kind: 'case' } : n.target.kind === 'document' ? { kind: 'document', ref: n.target.anchor.refAtCreation, resultsVersion: n.target.anchor.resultsVersion } : { kind: 'analysis', section: n.target.section },
});
const newest = (a: NoteItem, b: NoteItem) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1);

export async function loadNotes(services: RequestServices, raw: string | undefined) {
  const { caseId, info } = await readCase(services, raw);
  // The case's notes and the page notes written in its originals' viewer, in one read: neither is shown without the other.
  const [work, current, canWrite] = await Promise.all([part(services.userWork.readNoteWork({ caseId, target: null, store: PAGE_NOTE_STORE })), currentVersion(services, info), canWriteWork(services, caseId)]);
  const resultsVersion = current.kind === 'current' ? current.resultsVersion : null;
  return {
    caseId, label: info.caseLabel ?? info.caseId, caseHref: caseHref(caseId), notesHref: notesHref(caseId),
    chronologyHref: resultsVersion ? chronologyHref(caseId, resultsVersion) : null,
    /** annotations attach to documents of this version only; null while results are pending, withdrawn or unavailable */
    resultsVersion,
    notes: work.state === 'available' ? { state: 'available' as const, items: work.value.notes.map(item).sort(newest) } : { state: 'unavailable' as const, items: [] as NoteItem[] },
    /** read only here: each links to its original's viewer, where it is changed or deleted */
    pageNotes: work.state === 'available' ? pageNotes(caseId, work.value.rows) : ({ items: [], unreadable: 0 } satisfies PageNotes),
    /** a fresh operation id per rendered form; a resubmission of the same form repeats, never duplicates, the write */
    operationId: crypto.randomUUID(),
    /** false for a viewer: the page shows the notes without the add and delete forms */
    canWrite,
  };
}

const text = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };
/** A fault on a write keeps the user's text and says the note was not saved; a denial is the page's refusal. */
function writeFault(e: unknown, keep: Omit<NoteRefusal, 'message'>, operationId: string) {
  if (isDenial(e)) refuse(e, 'write');
  const code = codeOf(e);
  if (code === 'invalid') return fail(400, { ...keep, message: 'That note cannot be saved. Check its text and try again.' } satisfies NoteRefusal);
  if (code === 'not-found') return fail(409, { ...keep, message: 'That document is not in the current results, so the note was not saved. Your text is kept below.' } satisfies NoteRefusal);
  return fail(503, { ...keep, operationId, message: 'Your notes are unavailable right now, so this may not have been saved. Your text is kept below; try again shortly.' } satisfies NoteRefusal);
}
async function serverNotes(services: RequestServices, caseId: CaseId): Promise<NoteItem[] | undefined> {
  const r = await part(services.userWork.notesFor({ caseId, target: null }));
  return r.state === 'available' ? r.value.map(item).sort(newest) : undefined;
}

async function documentTarget(services: RequestServices, info: CaseInfo, ref: string, rv: string): Promise<NoteTarget | 'moved'> {
  const current = await currentVersion(services, info);
  if (current.kind !== 'current' || current.resultsVersion !== rv) return 'moved';
  const resultsVersion: ResultsVersion = current.resultsVersion;
  return { kind: 'document', anchor: await services.userWork.anchorFor({ caseId: info.caseId, resultsVersion, ref }) };
}

export async function addNote({ locals, params, request }: RequestEvent) {
  const { caseId, info } = await readCase(locals, (params as Record<string, string | undefined>).caseId);
  const f = await request.formData();
  const body = text(f, 'body'), ref = text(f, 'ref').trim(), rv = text(f, 'resultsVersion'), operationId = text(f, 'operationId');
  const keep = { op: 'add' as const, body, ref, resultsVersion: rv, ...(OPERATION.test(operationId) ? { operationId } : {}) };
  if (!body.trim() || body.length > MAX_NOTE) return fail(400, { ...keep, message: body.trim() ? `A note can be at most ${MAX_NOTE.toLocaleString('en')} characters.` : 'Write the note before saving it.' } satisfies NoteRefusal);
  if (!OPERATION.test(operationId) || (ref && !TOKEN.test(ref))) return fail(400, { ...keep, message: 'This form is out of date. Your text is kept below; save it again.' } satisfies NoteRefusal);
  try {
    const target = ref ? await documentTarget(locals, info, ref, rv) : ({ kind: 'case' } as const);
    if (target === 'moved') return fail(409, { ...keep, message: 'The published results changed since this page loaded, so the annotation was not saved. Your text is kept below.', notes: await serverNotes(locals, caseId) } satisfies NoteRefusal);
    const written = await locals.userWork.addNote({ caseId, expected: { kind: 'absent' }, operationId, target, body });
    if (written.kind !== 'written') return fail(409, { ...keep, message: 'Your notes changed on the server since this page loaded, so nothing was saved. Your text is kept below.', notes: await serverNotes(locals, caseId) } satisfies NoteRefusal);
  } catch (e) {
    return writeFault(e, keep, operationId);
  }
  redirect(303, `${notesHref(caseId)}?saved=1`);
}

export async function deleteNote({ locals, params, request }: RequestEvent) {
  const { caseId } = await readCase(locals, (params as Record<string, string | undefined>).caseId);
  const f = await request.formData();
  const noteId = text(f, 'id'), version = text(f, 'version'), operationId = text(f, 'operationId');
  if (!TOKEN.test(noteId) || !TOKEN.test(version) || !OPERATION.test(operationId)) return fail(400, { op: 'delete', message: 'This form is out of date. Reload the page and try again.' } satisfies NoteRefusal);
  const step = deleteStep(f, noteId);
  if (step !== 'confirm') return fail(400, { op: 'delete', confirm: step === 'ask' ? noteId : null } satisfies NoteRefusal);
  try {
    const written = await locals.userWork.deleteNote({ caseId, id: noteId, expected: { kind: 'match', version: id('row-version', version) }, operationId });
    if (written.kind !== 'written') {
      const notes = await serverNotes(locals, caseId);
      const current = notes ? notes.find((n) => n.id === noteId) ?? null : undefined;
      return fail(409, { op: 'delete', message: written.kind === 'gone' ? 'That note was already deleted.' : 'That note changed on the server since this page loaded, so it was not deleted. Its current text is shown.', current, notes } satisfies NoteRefusal);
    }
  } catch (e) {
    return writeFault(e, { op: 'delete' }, operationId);
  }
  redirect(303, `${notesHref(caseId)}?deleted=1`);
}
