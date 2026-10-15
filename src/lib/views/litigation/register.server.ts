import { fail } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { guarded, type Say } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { registers, type DeleteResult, type VersionedRow } from '$lib/local-case/registers.server';
import type { RegisterValue, UserWorkError } from '$lib/local-case/user-work.server';

export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

export const register = (caseId: string, store: string) => registers(app().userWork).open(caseId, store);

export const orderedRows = (caseId: string, store: string): VersionedRow[] => register(caseId, store).rows();

export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };

export const valuesOf = <K extends string>(f: FormData, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, field(f, k)])) as Record<K, string>;

export const deleteValue = (id: string, version: string) => `${id} ${version}`;
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

export async function deleteAnswer<V extends Record<string, string>>(target: string, values: V, write: () => Promise<DeleteResult | 'absent'>) {
	const r = await guarded('delete', values, write, SAY.delete, { target });
	if (!r.ok) return r.failure;
	if (r.value === 'deleted') return { op: 'delete' as const, target, deleted: target, values };
	if (r.value === 'gone') return { op: 'delete' as const, target, gone: true, message: DELETE_GONE, values };
	if (r.value === 'stale') return fail(409, { op: 'delete', target, values, message: DELETE_STALE, retry: false });
	return fail(404, { op: 'delete', target, values, message: 'Not deleted: that topic is not in this results version.', retry: false });
}

export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>) =>
	[...resolveRefs(app().store, resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];
