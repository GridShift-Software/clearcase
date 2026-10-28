// The answers and the store port the entry actions of Litigation, Quantum and Evidence share (sprint ticket 17b). Nothing here
// opens a store: an action takes its case, its `Entries` and its `guard` from a `Ctx`, so the local pages (the local work
// store, `register.server.ts`) and the hosted routes (the user-work adapter, `hosted.server.ts`) run the same action code.
// It imports only types from the local modules, so it stays inside the hosted import graph.
import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { deleteStep } from '../../components/confirm-delete.ts';
import type { Say } from '../../local-case/answer.server.ts';
import type { DeleteResult } from '../../local-case/registers.server.ts';
import type { RegisterValue, UserWorkError } from '../../local-case/user-work.server.ts';
import { deleteValue } from './crossexam.ts';

export { deleteValue };
export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

export type Fields = Record<string, RegisterValue>;

/** What the entry actions ask of a store. `version` is the one the page showed; `null` is a scripted post without one. */
export interface Entries {
	/** One row, once: a retry with the same `addId` and the same fields adds no second. */
	add(store: string, fields: Fields, addId: string | null): Promise<{ rowId: string }>;
	remove(store: string, rowId: string, version: string | null): Promise<DeleteResult>;
	/** Deleting an imported row writes a seed overlay that marks it deleted; the seed itself is never touched. */
	removeSeed(datasetKey: string, seedId: string, version: string | null): Promise<DeleteResult | 'absent'>;
}

export type Guard = <T, V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(
	op: string, values: V, write: () => Promise<T>, say: Say, extra?: X,
) => Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<X & { op: string; values: V; message: string; retry: boolean }> }>;

export interface Ctx { caseId: string; entries: Entries; guard: Guard }
export type CtxOf<C extends Ctx = Ctx> = (event: Pick<RequestEvent, 'params' | 'locals'>) => C;

export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };

export const valuesOf = <K extends string>(f: FormData, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, field(f, k)])) as Record<K, string>;

/** The id and version of a Delete button's value; a value without a version (a scripted post) is not re-checked. */
export function deleteTarget(v: string): { id: string; version: string | null } {
	const i = v.lastIndexOf(' ');
	return i < 0 ? { id: v, version: null } : { id: v.slice(0, i), version: v.slice(i + 1) || null };
}

const OPERATION = /^[0-9a-f-]{8,64}$/;
/** The id the form carries so a retry of one submission is one write: `addId` on the litigation forms, `operationId` on the others. */
export const formAddId = (f: FormData) => { const v = field(f, 'addId') || field(f, 'operationId'); return OPERATION.test(v) ? v : null; };

export const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

export const BUSY = 'Not saved: the local store is busy. Your entry is kept below; try again in a moment.';
export const DELETE_BUSY = 'Not deleted: the local store is busy. Nothing was changed; try again in a moment.';
export const DELETE_GONE = 'This entry was already deleted elsewhere (in another tab or window). Nothing else was changed.';
export const DELETE_STALE = 'Not deleted: this entry was changed elsewhere after this page was loaded. It is shown as it is now; delete it again if you still want it gone.';

export const FAILED = 'Not saved: the app hit an error while saving. Your entry is kept below.';
export const DELETE_FAILED = 'Not deleted: the app hit an error. Check the table before you delete the entry again.';
const refused = (e: UserWorkError) => `Not saved: ${e.message}`;
export const SAY = { add: { busy: BUSY, refused, failed: FAILED }, delete: { busy: DELETE_BUSY, refused, failed: DELETE_FAILED } } satisfies Record<string, Say>;

export async function addAnswer<V extends Record<string, string>>(ctx: Ctx, store: string, values: V, addId: string | null) {
	const r = await ctx.guard('add', values, () => ctx.entries.add(store, values, addId), SAY.add);
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

export async function deleteAnswerOf<V extends Record<string, string>>(ctx: Ctx, target: string, values: V, write: () => Promise<DeleteResult | 'absent'>) {
	const r = await ctx.guard('delete', values, write, SAY.delete, { target });
	if (!r.ok) return r.failure;
	if (r.value === 'deleted') return { op: 'delete' as const, target, deleted: target, values };
	if (r.value === 'gone') return { op: 'delete' as const, target, gone: true, message: DELETE_GONE, values };
	if (r.value === 'stale') return fail(409, { op: 'delete', target, values, message: DELETE_STALE, retry: false });
	return fail(404, { op: 'delete', target, values, message: 'Not deleted: that topic is not in this results version.', retry: false });
}
