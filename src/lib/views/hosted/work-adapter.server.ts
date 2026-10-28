import { fail, isHttpError } from '@sveltejs/kit';
import type { Say, Work } from '../../local-case/answer.server.ts';
import type { DocumentAnchor } from '../../case-package/user-work.ts';
import type { NoteView } from '../../server/runtime/dto.ts';
import type * as C from '../../server/runtime/contracts.ts';
import { codeOf, contractError, isDenial } from '../../server/runtime/errors.ts';
import { id, resultsVersion } from '../../server/runtime/ids.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';

export type { Work };
type Form = FormData | Readonly<Record<string, string>>;
const text = (form: Form | undefined, key: string) => form instanceof FormData ? String(form.get(key) ?? '') : form?.[key] ?? '';
const changed = 'This was changed by someone else. Reload the page and try again.';
const gone = 'This was already deleted. Reload the page to see the current records.';

function unwrap<T>(result: C.Written<T>): T {
  if (result.kind !== 'written') throw contractError(result.kind);
  return result.value;
}
export function noteView(note: C.HostedNote & { version?: C.WorkVersion }): NoteView & { version?: string } {
  if (note.target.kind !== 'document') throw contractError('invalid');
  const { target, ...rest } = note;
  return { ...rest, refAtCreation: target.anchor.refAtCreation, resultsVersion: target.anchor.resultsVersion, anchorSha256: target.anchor.sha256 };
}

/** One instance per action. Tokens belong to its submitted form, never a process-global cache. */
export function hostedWork(locals: Pick<C.RequestServices, 'userWork'>, rawCaseId: string, rawVersion: string, form?: Form): Work {
  const work = locals.userWork, caseId = id('case', rawCaseId), rv = resultsVersion(rawVersion);
  const operationId = text(form, 'operationId') || text(form, 'addId') || crypto.randomUUID();
  const version = text(form, 'version');
  const expected: C.Expected = version ? { kind: 'match', version: id('row-version', version) } : { kind: 'absent' };
  const scope = (c: string) => { if (c !== caseId) throw contractError('forbidden'); return { caseId }; };
  const versionScope = (c: string, v: string) => { scope(c); if (v !== rv) throw contractError('forbidden'); return { caseId, resultsVersion: rv }; };
  const update = () => { if (expected.kind !== 'match') throw contractError('stale'); return { caseId, operationId, expected }; };
  const anchor = async (a: DocumentAnchor | null) => a ? work.anchorFor({ ...versionScope(a.caseId, a.resultsVersion), ref: a.refAtCreation }) : null;
  return {
    async listRows(c, store) {
      return (await work.listRows({ ...scope(c), store })).map((row) => ({ ...row, anchor: row.anchor?.sha256 ? row.anchor as DocumentAnchor : null }));
    },
    async putRow(c, store, rowId, fields, a = null) {
      return unwrap(await work.putRow({ ...scope(c), store, rowId, fields, anchor: await anchor(a), operationId, expected })).rowId;
    },
    async deleteRow(c, store, rowId) { scope(c); return unwrap(await work.deleteRow({ ...update(), store, rowId })); },
    async seedViews(c, v, datasetKey) { return [...await work.seedViews({ ...versionScope(c, v), ...(datasetKey ? { datasetKey } : {}) })]; },
    async putSeedOverlay(overlay) { unwrap(await work.putSeedOverlay({ ...scope(overlay.caseId), overlay, operationId, expected })); },
    async notesFor(c, v, ref) {
      const target: C.NoteTarget = { kind: 'document', anchor: await work.anchorFor({ ...versionScope(c, v), ref }) };
      return (await work.notesFor({ caseId, target })).map(noteView);
    },
    async addNote(c, v, ref, body) {
      const target: C.NoteTarget = { kind: 'document', anchor: await work.anchorFor({ ...versionScope(c, v), ref }) };
      if (expected.kind !== 'absent') throw contractError('invalid');
      const result = await work.addNote({ caseId, target, body, expected, operationId });
      const value = unwrap(result);
      return noteView({ ...value, ...(result.kind === 'written' ? { version: result.version } : {}) });
    },
    async deleteNote(c, noteId) { scope(c); return unwrap(await work.deleteNote({ ...update(), id: noteId })); },
    async listTableRows(table, options) { scope(options?.caseId ?? ''); return (await work.listTableRows({ caseId, table })).map(({ cells }) => cells); },
    async putTableRow(table, row, options) { scope(String(row.case_id ?? '')); unwrap(await work.putTableRow({ caseId, table, row, owner: options.owner, expected, operationId })); },
  };
}

/** Hosted failures retain the local Answer shape. Never log raw exceptions or return storage details. */
export async function guarded<T, V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, write: (work: Work) => Promise<T>, say: Say, extra: X = {} as X, work?: Work) {
  try {
    if (!work && write.length) throw contractError('invalid');
    const value = await write(work as Work);
    if (value && typeof value === 'object' && 'kind' in value && (value.kind === 'stale' || value.kind === 'gone')) throw contractError(value.kind);
    return { ok: true as const, value };
  } catch (e) {
    if (isDenial(e)) refuse(e, 'write');
    const code = codeOf(e);
    const busy = (isHttpError(e) && e.status === 503) || ['storage-unavailable', 'audit-unavailable', 'identity-unavailable', 'busy'].includes(code ?? '');
    const conflict = code === 'stale' || code === 'gone';
    // Say's legacy callback accepts a UserWorkError; supply a sanitized structural error, never the backend message.
    const refused = typeof say.refused === 'string' ? say.refused : say.refused(Object.assign(new Error('The request was refused. Check the form and try again.'), { code: 'invalid' as const }));
    const message = busy ? say.busy : conflict ? (code === 'gone' ? gone : changed) : code ? refused : say.failed;
    return { ok: false as const, failure: fail(busy ? 503 : conflict ? 409 : code ? 400 : 500, { ...extra, op, values, message, retry: busy, ...(code === 'gone' ? { gone: true } : {}) }) };
  }
}
