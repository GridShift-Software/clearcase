// The JSON endpoint behind the viewer's page notes. Reads need the original's read-original authority (checked by the
// assets handle before any row is listed); writes also need write-user-work (checked by the user-work service).
// Writes accept only a same-origin JSON body of bounded size. Nothing is persisted outside AsyncUserWork.
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { codeOf } from '../../server/runtime/errors.ts';
import { id, type WorkVersion } from '../../server/runtime/ids.ts';
import { assetRefOf } from './route.ts';
import { addPageNote, listPageNotes, removePageNote } from './page-notes.ts';

const MAX_JSON = 8 * 1024;
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };

/** The original is authorized as a read first: an original the caller cannot reach is absent (404), a write denial is for the user-work step only. */
async function scope(e: RequestEvent) {
  const asset = assetRefOf('original', e.params as Record<string, string | undefined>);
  await e.locals.assets.metadata({ asset }).catch((x) => refuse(x, 'read'));
  return { work: e.locals.userWork, assets: e.locals.assets, caseId: asset.caseId, assetId: asset.assetId };
}
async function body(e: RequestEvent): Promise<Record<string, unknown>> {
  // A write comes from this origin's own page: no Origin, or another one, is refused before the body is read.
  if (e.request.headers.get('origin') !== e.url.origin) error(403, { message: 'You do not have permission to do that.', code: 'forbidden' });
  if (!(e.request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) error(415, { message: 'Send JSON.', code: 'invalid' });
  const declared = Number(e.request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_JSON) error(413, { message: 'Too large.', code: 'invalid' });
  const text = await e.request.text();
  if (text.length > MAX_JSON) error(413, { message: 'Too large.', code: 'invalid' });
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* falls through */ }
  return error(400, { message: 'Send a JSON object.', code: 'invalid' });
}
const operation = (b: Record<string, unknown>) => (typeof b.operationId === 'string' && OP.test(b.operationId) ? b.operationId : error(400, { message: 'An operation id is required.', code: 'invalid' }));
const rejected = (e: unknown, access: 'read' | 'write'): never => (codeOf(e) === 'invalid' ? error(400, { message: 'That note is not valid.', code: 'invalid' }) : refuse(e, access));
const stale = () => json({ code: 'stale' }, { status: 409, headers: NO_STORE });

export async function listNotes(e: RequestEvent): Promise<Response> {
  const s = await scope(e);
  return json({ notes: await listPageNotes(s).catch((x) => rejected(x, 'read')) }, { headers: NO_STORE });
}
export async function createNote(e: RequestEvent): Promise<Response> {
  const b = await body(e), s = await scope(e);
  const w = await addPageNote({ ...s, page: b.page, body: b.body, operationId: operation(b) }).catch((x) => rejected(x, 'write'));
  return w.kind === 'written' ? json({ note: w.note }, { status: 201, headers: NO_STORE }) : stale();
}
export async function deleteNote(e: RequestEvent): Promise<Response> {
  const b = await body(e), s = await scope(e);
  if (typeof b.rowId !== 'string' || !OP.test(b.rowId) || typeof b.version !== 'string' || !OP.test(b.version)) error(400, { message: 'A note and its version are required.', code: 'invalid' });
  const r = await removePageNote({ ...s, rowId: b.rowId as string, expected: id('row-version', b.version as string) as WorkVersion, operationId: operation(b) }).catch((x) => rejected(x, 'write'));
  return r === 'removed' ? json({ removed: true }, { headers: NO_STORE }) : r === 'gone' ? error(404, { message: 'Not found.', code: 'not-found' }) : stale();
}
