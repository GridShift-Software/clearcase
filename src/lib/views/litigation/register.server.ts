import { fail } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { deleteStep } from '$lib/components/confirm-delete';
import { guarded, type Say } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { registers, type DeleteResult, type VersionedRow } from '$lib/local-case/registers.server';
import { datasetOf, exportFileName, viewText } from '$lib/local-case/results.server';
import type { CaseStore } from '$lib/local-case/store.server';
import type { RegisterValue, UserWorkError } from '$lib/local-case/user-work.server';
import type { PureInput } from '$lib/views/payloads/views';
import { AUTH_FIELDS, AUTH_FILE, type AuthValues } from './authorities.ts';
import { CX_SEED } from './crossexam.ts';

export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

export const register = (caseId: string, store: string) => registers(app().userWork).open(caseId, store);

export const orderedRows = (caseId: string, store: string): VersionedRow[] => register(caseId, store).rows();

export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };

export const valuesOf = <K extends string>(f: FormData, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, field(f, k)])) as Record<K, string>;

export { deleteValue } from './crossexam.ts';
/** The id and version of a Delete button's value; a value without a version (a scripted post) is not re-checked. */
export function deleteTarget(v: string): { id: string; version: string | null } {
	const i = v.lastIndexOf(' ');
	return i < 0 ? { id: v, version: null } : { id: v.slice(0, i), version: v.slice(i + 1) || null };
}

export const formAddId = (f: FormData) => { const v = field(f, 'addId'); return /^[0-9a-f-]{8,64}$/.test(v) ? v : null; };

export const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

export const BUSY = 'Not saved: the local store is busy. Your entry is kept below; try again in a moment.';
export const DELETE_BUSY = 'Not deleted: the local store is busy. Nothing was changed; try again in a moment.';
export const DELETE_GONE = 'This entry was already deleted elsewhere (in another tab or window). Nothing else was changed.';
export const DELETE_STALE = 'Not deleted: this entry was changed elsewhere after this page was loaded. It is shown as it is now; delete it again if you still want it gone.';

export const FAILED = 'Not saved: the app hit an error while saving. Your entry is kept below.';
export const DELETE_FAILED = 'Not deleted: the app hit an error. Check the table before you delete the entry again.';
const refused = (e: UserWorkError) => `Not saved: ${e.message}`;
export const SAY = { add: { busy: BUSY, refused, failed: FAILED }, delete: { busy: DELETE_BUSY, refused, failed: DELETE_FAILED } } satisfies Record<string, Say>;

export async function addAction<V extends Record<string, string>>(caseId: string, store: string, values: V, addId: string | null) {
	const r = await guarded('add', values, () => register(caseId, store).add(values, { addId }), SAY.add);
	return r.ok ? { op: 'add' as const, added: r.value.rowId } : r.failure;
}

/**
 * The refusal of a Delete that is not confirmed for `raw`, its Delete button's value, or null when it is (GRS-175).
 * Nothing is deleted; the add form's entry comes back, and the page asks for the confirmation unless this was a Cancel.
 */
export function unconfirmed<V extends Record<string, string>>(f: FormData, raw: string, values: V) {
	const step = deleteStep(f, raw);
	return step === 'confirm' ? null : fail(400, { op: 'delete' as const, values, confirm: step === 'ask' ? raw : null });
}

export async function deleteAnswer<V extends Record<string, string>>(target: string, values: V, write: () => Promise<DeleteResult | 'absent'>) {
	const r = await guarded('delete', values, write, SAY.delete, { target });
	if (!r.ok) return r.failure;
	if (r.value === 'deleted') return { op: 'delete' as const, target, deleted: target, values };
	if (r.value === 'gone') return { op: 'delete' as const, target, gone: true, message: DELETE_GONE, values };
	if (r.value === 'stale') return fail(409, { op: 'delete', target, values, message: DELETE_STALE, retry: false });
	return fail(404, { op: 'delete', target, values, message: 'Not deleted: that topic is not in this results version.', retry: false });
}

export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>, store: CaseStore = app().store) =>
	[...resolveRefs(store, resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];

// Authorities and Cross-examination without their registers (ticket 04): what the operator machine builds into the shards.

export function authoritiesPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<unknown[]>(store, vid, 'lit-authorities');
	const imported = (Array.isArray(raw) ? raw : []).map((r) => {
		const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		return Object.fromEntries(AUTH_FIELDS.map((k) => [k, o[k] === null || o[k] === undefined ? '' : String(o[k])])) as AuthValues;
	});
	return { present: Array.isArray(raw), imported, known: knownRefs(vid, imported.map((r) => r.proposition), store), exportName: exportFileName(vc, 'authorities_tab', AUTH_FILE) };
}

export function crossexamPure({ store, vid, vc }: PureInput) {
	const puts = store.seeds(vid).filter((s) => s.dataset_key === CX_SEED).map((s) => (JSON.parse(s.record_json) as Record<string, unknown>).put);
	// the cited refs of every imported topic; the page links those of the topics it still shows as imported
	return { tip: viewText(vc, 'crossexam_tab', 'tip'), knownSeedRefs: knownRefs(vid, puts, store) };
}
