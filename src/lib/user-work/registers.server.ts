// Register persistence for GRS-17 (CC-07): one register_row store per register, through app().userWork only
// (putRow/listRows/deleteRow), scoped to the case. Each row holds v5's string fields under v5's keys plus an integer
// `seq` (max + 1 at insert, kept on edit): listRows orders by createdAt and rowId, which is not insertion order under
// a fixed clock, so the register order is seq, then createdAt, then rowId. Rows are never keyed by position.
//
// Every register write (add, edit, delete) of one case's store runs in one in-process queue, so an edit re-reads its
// row just before putRow with no other register write of this process in between: an edit never re-creates a row
// another tab deleted (putRow upserts), and an edit made from a stale copy of the row is refused by its version (a
// hash of the stored fields, anchor and updatedAt; under CLEARCASE_FIXED_NOW updatedAt never changes, the fields do).
// The queue is the register store's (local-case/registers.server.ts), so a restore of the case holds these writes back.
import { createHash } from 'node:crypto';
import type { DocumentAnchor } from '../case-package/index.ts';
import { inTurn } from '../local-case/registers.server.ts';
import type { RegisterRow, UserWork } from '../local-case/user-work.server.ts';
import type { RegisterDef } from '../views/registers/defs.ts';
import type { Entry, Row } from '../views/registers/logic.ts';

export interface StoredRow extends Row { seq: number; anchor: DocumentAnchor | null; createdAt: string; updatedAt: string; intact: boolean; version: string }
type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow'>;
/** An edit's outcome: saved, the row is gone (deleted elsewhere), or the row changed since the editor loaded it. */
export type EditResult = 'saved' | 'gone' | 'stale';

const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const order = (a: StoredRow, b: StoredRow) => a.seq - b.seq || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);
const seqOf = (r: RegisterRow): number | null => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : null);

/** The row's version: changes on every write of its fields or anchor (listRows returns the fields in stored key order). */
export const versionOf = (r: RegisterRow): string => createHash('sha256').update(JSON.stringify([r.fields, r.anchor, r.updatedAt])).digest('hex').slice(0, 32);

function stored(def: RegisterDef, r: RegisterRow): StoredRow {
	const values = Object.fromEntries(def.fields.map((x) => [x.k, text(r.fields[x.k])]));
	return { rowId: r.rowId, values, seq: seqOf(r) ?? Number.MAX_SAFE_INTEGER, anchor: r.anchor, createdAt: r.createdAt, updatedAt: r.updatedAt, intact: r.intact, version: versionOf(r) };
}

/** Run one register write after every earlier write of the same store, case and service (a failed write does not block the queue). */
const serial = <T>(w: Work, caseId: string, store: string, fn: () => Promise<T>): Promise<T> => inTurn(w, caseId, store, fn);

/** Every row of a case's register, in register (insertion) order. */
export const listRegister = (w: Work, caseId: string, def: RegisterDef): StoredRow[] => w.listRows(caseId, def.store).map((r) => stored(def, r)).sort(order);

/** Insert one entry after the last; returns its stable row id. Throws as putRow does (a busy store is a 503). */
export function addEntry(w: Work, caseId: string, def: RegisterDef, e: Entry, anchor: DocumentAnchor | null = null): Promise<string> {
	return serial(w, caseId, def.store, async () => {
		const seq = w.listRows(caseId, def.store).reduce((m, r) => Math.max(m, seqOf(r) ?? 0), 0) + 1;
		return w.putRow(caseId, def.store, null, { ...fieldsOf(def, e), seq }, anchor);
	});
}

/**
 * Replace one entry's fields (and anchor), keeping its id and position. 'gone' when the row no longer exists (nothing
 * is written: an edit never inserts), 'stale' when `version` is given and the stored row's differs. A row without a
 * numeric seq (a restore, a v5 import) keeps none, so it stays last. `anchor` may be a function of the current row, run
 * inside the serialized edit, so an edit that leaves the document ref alone can keep the row's own anchor.
 */
export function editEntry(w: Work, caseId: string, def: RegisterDef, rowId: string, e: Entry, anchor: DocumentAnchor | null | ((cur: StoredRow) => DocumentAnchor | null) = null, version: string | null = null): Promise<EditResult> {
	return serial(w, caseId, def.store, async () => {
		const cur = w.listRows(caseId, def.store).find((r) => r.rowId === rowId);
		if (!cur) return 'gone';
		if (version !== null && versionOf(cur) !== version) return 'stale';
		const seq = seqOf(cur);
		await w.putRow(caseId, def.store, rowId, { ...fieldsOf(def, e), ...(seq === null ? {} : { seq }) }, typeof anchor === 'function' ? anchor(stored(def, cur)) : anchor);
		return 'saved';
	});
}

/** Delete one entry by its stable id (never by position, S-deadlines_tab-1); whether a row was deleted. */
export const deleteEntry = (w: Work, caseId: string, def: RegisterDef, rowId: string): Promise<boolean> => serial(w, caseId, def.store, () => w.deleteRow(caseId, def.store, rowId));

const fieldsOf = (def: RegisterDef, e: Entry) => Object.fromEntries(def.fields.map((x) => [x.k, e[x.k] ?? '']));
