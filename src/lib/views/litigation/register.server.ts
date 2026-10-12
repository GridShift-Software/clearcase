// Server helpers shared by the litigation views (GRS-18): flat user registers in app().userWork, each written through
// the register store (local-case/registers.server.ts: insertion order, versions, the write queue), the failure answer
// that turns a busy store into a visible failure that keeps the typed values (local-case/answer.server.ts), and the refs
// authored text cites.
import { fail } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { guarded, type Say } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { registers, type DeleteResult, type VersionedRow } from '$lib/local-case/registers.server';
import type { RegisterValue, UserWorkError } from '$lib/local-case/user-work.server';

/** The register stores this ticket writes (one per register; see the report's user-work design). */
export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

/** A case's register store. */
export const register = (caseId: string, store: string) => registers(app().userWork).open(caseId, store);

/** A case's rows of one store in insertion order, each with its version. */
export const orderedRows = (caseId: string, store: string): VersionedRow[] => register(caseId, store).rows();

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

export const FAILED = 'Not saved: the app hit an error while saving. Your entry is kept below.';
export const DELETE_FAILED = 'Not deleted: the app hit an error. Check the table before you delete the entry again.';
const refused = (e: UserWorkError) => `Not saved: ${e.message}`;
/** What the litigation forms say when a write fails (answer.server.ts). */
export const SAY = { add: { busy: BUSY, refused, failed: FAILED }, delete: { busy: DELETE_BUSY, refused, failed: DELETE_FAILED } } satisfies Record<string, Say>;

/** An Add action's answer: the new row, or the refusal with the typed values. */
export async function addAction<V extends Record<string, string>>(caseId: string, store: string, values: V, addId: string | null) {
	const r = await guarded('add', values, () => register(caseId, store).add(values, { addId }), SAY.add);
	return r.ok ? { op: 'add' as const, added: r.value.rowId } : r.failure;
}

/**
 * A Delete action's answer, with the add form's values carried through (without JavaScript the Delete posts the add
 * form, so a typed or refused entry comes back in the answer). Already gone is said, never an error page.
 */
export async function deleteAnswer<V extends Record<string, string>>(target: string, values: V, write: () => Promise<DeleteResult | 'absent'>) {
	const r = await guarded('delete', values, write, SAY.delete, { target });
	if (!r.ok) return r.failure;
	if (r.value === 'deleted') return { op: 'delete' as const, target, deleted: target, values };
	if (r.value === 'gone') return { op: 'delete' as const, target, gone: true, message: DELETE_GONE, values };
	if (r.value === 'stale') return fail(409, { op: 'delete', target, values, message: DELETE_STALE, retry: false });
	return fail(404, { op: 'delete', target, values, message: 'Not deleted: that topic is not in this results version.', retry: false });
}

/** The refs cited by `[[REF]]` tokens in authored texts that name a document row of the version (for Narrative). */
export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>) =>
	[...resolveRefs(app().store, resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];
