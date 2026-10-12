// Server helpers shared by the litigation views (GRS-18): flat user registers in app().userWork kept in insertion
// order by an explicit integer `seq` (listRows orders by createdAt, which ties under a fixed clock), the guard that
// turns a busy store into a visible failure that keeps the typed values, and the refs authored text cites. Every write
// goes through the write queue in writes.server.ts.
import { fail, isHttpError } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { app } from '$lib/local-case/app.server';
import { UserWorkError, type RegisterRow, type RegisterValue } from '$lib/local-case/user-work.server';
import { serialized } from './serial.ts';
import { addEntry, deleteEntry, nextSeq, rowVersion, type DeleteResult } from './writes.server.ts';

export { nextSeq, rowVersion, serialized };

/** The register stores this ticket writes (one per register; see the report's user-work design). */
export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

const seqOf = (r: RegisterRow) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER);

/** A case's rows of one store in insertion order: by `seq`, then by creation time and id for rows without one. */
export function orderedRows(caseId: string, store: string): RegisterRow[] {
	return app().userWork.listRows(caseId, store).sort((a, b) => seqOf(a) - seqOf(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : 1));
}

/** Insert a register row with the next `seq`, in the write queue; `addId` (the form's) keeps a repeated post from adding twice. */
export const addRow = (caseId: string, store: string, fields: Record<string, RegisterValue>, addId: string | null = null) => addEntry(app().userWork, caseId, store, fields, addId);

/** A form field as the user typed it (v5 `val()`: untrimmed, '' when absent). */
export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };

/** The values of an entry form's fields. */
export const valuesOf = <K extends string>(f: FormData, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, field(f, k)])) as Record<K, string>;

/** A Delete button's value: the row (or seed) id and the version of the row the page showed, `<id> <version>`. */
export const deleteValue = (id: string, version: string) => `${id} ${version}`;
/** The id and version of a Delete button's value; a value without a version (a scripted post) is not re-checked. */
export function deleteTarget(v: string): { id: string; version: string | null } {
	const i = v.lastIndexOf(' ');
	return i < 0 ? { id: v, version: null } : { id: v.slice(0, i), version: v.slice(i + 1) || null };
}

/** The add form's one-time id (a hidden field): a repeated post of one form stores one row. */
export const formAddId = (f: FormData) => { const v = field(f, 'addId'); return /^[0-9a-f-]{8,64}$/.test(v) ? v : null; };

/** Plain text of a register field (a stored value of another type is shown as text, never as markup). */
export const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

export const BUSY = 'Not saved: the local store is busy. Your entry is kept below; try again in a moment.';
export const DELETE_BUSY = 'Not deleted: the local store is busy. Nothing was changed; try again in a moment.';
export const DELETE_GONE = 'This entry was already deleted elsewhere (in another tab or window). Nothing else was changed.';
export const DELETE_STALE = 'Not deleted: this entry was changed elsewhere after this page was loaded. It is shown as it is now; delete it again if you still want it gone.';

/**
 * Run a user-work write. A busy store (the API's 503 after its retries) and a refused write become `fail` with the
 * typed values, so the form keeps the user's input and shows the error; anything else is a real fault.
 */
export async function guarded<T, V extends Record<string, string>>(values: V, write: () => Promise<T>, extra: Record<string, unknown> = {}, busy = BUSY) {
	try {
		return { ok: true as const, value: await write() };
	} catch (e) {
		if (isHttpError(e) && e.status === 503) return { ok: false as const, failure: fail(503, { ...extra, values, message: busy, retry: true }) };
		if (e instanceof UserWorkError) return { ok: false as const, failure: fail(400, { ...extra, values, message: `Not saved: ${e.message}`, retry: false }) };
		throw e;
	}
}

/** An Add action's answer: the new row, or the refusal with the typed values. */
export async function addAction<V extends Record<string, string>>(caseId: string, store: string, values: V, addId: string | null) {
	const r = await guarded(values, () => addRow(caseId, store, values, addId), { op: 'add' });
	return r.ok ? { op: 'add' as const, added: r.value.rowId } : r.failure;
}

/**
 * A Delete action's answer, with the add form's values carried through (without JavaScript the Delete posts the add
 * form, so a typed or refused entry comes back in the answer). Already gone is said, never an error page.
 */
export async function deleteAnswer<V extends Record<string, string>>(target: string, values: V, write: () => Promise<DeleteResult | 'absent'>) {
	const r = await guarded(values, write, { op: 'delete', target }, DELETE_BUSY);
	if (!r.ok) return r.failure;
	if (r.value === 'deleted') return { op: 'delete' as const, target, deleted: target, values };
	if (r.value === 'gone') return { op: 'delete' as const, target, gone: true, message: DELETE_GONE, values };
	if (r.value === 'stale') return fail(409, { op: 'delete', target, values, message: DELETE_STALE, retry: false });
	return fail(404, { op: 'delete', target, values, message: 'Not deleted: that topic is not in this results version.', retry: false });
}

/** Delete a register row through the queue, re-checked against the version the page showed. */
export const deleteRowChecked = (caseId: string, store: string, rowId: string, version: string | null) => deleteEntry(app().userWork, caseId, store, rowId, version);

/** The refs cited by `[[REF]]` tokens in authored texts that exist in the version (for Narrative). */
export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>) =>
	[...app().store.existingRefs(resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];
