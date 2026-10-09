// Register persistence for GRS-17 (CC-07): one register_row store per register, through app().userWork only
// (putRow/listRows/deleteRow), scoped to the case. Each row holds v5's string fields under v5's keys plus an integer
// `seq` (max + 1 at insert, kept on edit): listRows orders by createdAt and rowId, which is not insertion order under
// a fixed clock, so the register order is seq, then createdAt, then rowId. Rows are never keyed by position.
import type { DocumentAnchor } from '../case-package/index.ts';
import type { RegisterRow, UserWork } from '../local-case/user-work.server.ts';
import type { RegisterDef } from '../views/registers/defs.ts';
import type { Entry, Row } from '../views/registers/logic.ts';

export interface StoredRow extends Row { seq: number; anchor: DocumentAnchor | null; createdAt: string; updatedAt: string; intact: boolean }
type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow'>;

const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const order = (a: StoredRow, b: StoredRow) => a.seq - b.seq || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);

function stored(def: RegisterDef, r: RegisterRow): StoredRow {
	const values = Object.fromEntries(def.fields.map((x) => [x.k, text(r.fields[x.k])]));
	const seq = typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER;
	return { rowId: r.rowId, values, seq, anchor: r.anchor, createdAt: r.createdAt, updatedAt: r.updatedAt, intact: r.intact };
}

/** Every row of a case's register, in register (insertion) order. */
export const listRegister = (w: Work, caseId: string, def: RegisterDef): StoredRow[] => w.listRows(caseId, def.store).map((r) => stored(def, r)).sort(order);

/** Insert one entry after the last; returns its stable row id. Throws as putRow does (a busy store is a 503). */
export async function addEntry(w: Work, caseId: string, def: RegisterDef, e: Entry, anchor: DocumentAnchor | null = null): Promise<string> {
	const rows = w.listRows(caseId, def.store);
	const seq = rows.reduce((m, r) => Math.max(m, typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : 0), 0) + 1;
	return w.putRow(caseId, def.store, null, { ...fieldsOf(def, e), seq }, anchor);
}

/** Replace one entry's fields (and anchor), keeping its id and position; false when the row no longer exists. */
export async function editEntry(w: Work, caseId: string, def: RegisterDef, rowId: string, e: Entry, anchor: DocumentAnchor | null = null): Promise<boolean> {
	const cur = w.listRows(caseId, def.store).find((r) => r.rowId === rowId);
	if (!cur) return false;
	await w.putRow(caseId, def.store, rowId, { ...fieldsOf(def, e), seq: typeof cur.fields.seq === 'number' ? cur.fields.seq : 0 }, anchor);
	return true;
}

/** Delete one entry by its stable id (never by position, S-deadlines_tab-1); whether a row was deleted. */
export const deleteEntry = (w: Work, caseId: string, def: RegisterDef, rowId: string): Promise<boolean> => w.deleteRow(caseId, def.store, rowId);

const fieldsOf = (def: RegisterDef, e: Entry) => Object.fromEntries(def.fields.map((x) => [x.k, e[x.k] ?? '']));
