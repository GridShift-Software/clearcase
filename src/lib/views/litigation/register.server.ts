// Server helpers shared by the litigation views (GRS-18): flat user registers in app().userWork kept in insertion
// order by an explicit integer `seq` (listRows orders by createdAt, which ties under a fixed clock), the guard that
// turns a busy store into a visible failure that keeps the typed values, and the refs authored text cites.
import { fail, isHttpError } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { app } from '$lib/local-case/app.server';
import { UserWorkError, type RegisterRow, type RegisterValue } from '$lib/local-case/user-work.server';
import { serialized } from './serial.ts';

export { serialized };

/** The register stores this ticket writes (one per register; see the report's user-work design). */
export const STORES = Object.freeze({ crossexam: 'crossexam', authorities: 'authorities', heads: 'heads', enforcement: 'enforcement-status' });

const seqOf = (r: RegisterRow) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER);

/** A case's rows of one store in insertion order: by `seq`, then by creation time and id for rows without one. */
export function orderedRows(caseId: string, store: string): RegisterRow[] {
	return app().userWork.listRows(caseId, store).sort((a, b) => seqOf(a) - seqOf(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : 1));
}

/** The next `seq` of a store: one more than the largest stored. */
export const nextSeq = (rows: readonly RegisterRow[]) => rows.reduce((m, r) => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) && r.fields.seq > m ? r.fields.seq : m), 0) + 1;

/** Insert a register row with the next `seq`, serialized per case and store. */
export const addRow = (caseId: string, store: string, fields: Record<string, RegisterValue>) =>
	serialized(`${caseId}\u0000${store}`, () => app().userWork.putRow(caseId, store, null, { ...fields, seq: nextSeq(app().userWork.listRows(caseId, store)) }));

/** A form field as the user typed it (v5 `val()`: untrimmed, '' when absent). */
export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : ''; };

/** Plain text of a register field (a stored value of another type is shown as text, never as markup). */
export const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

export const BUSY = 'Not saved: the local store is busy. Your entry is kept below; try again in a moment.';

/**
 * Run a user-work write. A busy store (the API's 503 after its retries) and a refused write become `fail` with the
 * typed values, so the form keeps the user's input and shows the error; anything else is a real fault.
 */
export async function guarded<T, V extends Record<string, string>>(values: V, write: () => Promise<T>) {
	try {
		return { ok: true as const, value: await write() };
	} catch (e) {
		if (isHttpError(e) && e.status === 503) return { ok: false as const, failure: fail(503, { values, message: BUSY }) };
		if (e instanceof UserWorkError) return { ok: false as const, failure: fail(400, { values, message: `Not saved: ${e.message}` }) };
		throw e;
	}
}

/** The refs cited by `[[REF]]` tokens in authored texts that exist in the version (for Narrative). */
export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>) =>
	[...app().store.existingRefs(resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];
