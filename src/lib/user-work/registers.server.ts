import { createHash } from 'node:crypto';
import type { DocumentAnchor } from '../case-package/index.ts';
import { inTurn } from '../local-case/registers.server.ts';
import type { RegisterRow, UserWork } from '../local-case/user-work.server.ts';
import type { RegisterDef } from '../views/registers/defs.ts';
import type { Entry, Row } from '../views/registers/logic.ts';

export interface StoredRow extends Row { seq: number; anchor: DocumentAnchor | null; createdAt: string; updatedAt: string; intact: boolean; version: string }
type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow'>;
export type EditResult = 'saved' | 'gone' | 'stale';

const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const order = (a: StoredRow, b: StoredRow) => a.seq - b.seq || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0);
const seqOf = (r: RegisterRow): number | null => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : null);

export const versionOf = (r: RegisterRow & { version?: string }): string => r.version ?? createHash('sha256').update(JSON.stringify([r.fields, r.anchor, r.updatedAt])).digest('hex').slice(0, 32);

function stored(def: RegisterDef, r: RegisterRow): StoredRow {
	const values = Object.fromEntries(def.fields.map((x) => [x.k, text(r.fields[x.k])]));
	return { rowId: r.rowId, values, seq: seqOf(r) ?? Number.MAX_SAFE_INTEGER, anchor: r.anchor, createdAt: r.createdAt, updatedAt: r.updatedAt, intact: r.intact, version: versionOf(r) };
}

const serial = <T>(w: Work, caseId: string, store: string, fn: () => Promise<T>): Promise<T> => inTurn(w, caseId, store, fn);

export const listRegister = (w: Work, caseId: string, def: RegisterDef): StoredRow[] => w.listRows(caseId, def.store).map((r) => stored(def, r)).sort(order);

export function addEntry(w: Work, caseId: string, def: RegisterDef, e: Entry, anchor: DocumentAnchor | null = null): Promise<string> {
	return serial(w, caseId, def.store, async () => {
		const seq = w.listRows(caseId, def.store).reduce((m, r) => Math.max(m, seqOf(r) ?? 0), 0) + 1;
		return w.putRow(caseId, def.store, null, { ...fieldsOf(def, e), seq }, anchor);
	});
}

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

export const deleteEntry = (w: Work, caseId: string, def: RegisterDef, rowId: string): Promise<boolean> => serial(w, caseId, def.store, () => w.deleteRow(caseId, def.store, rowId));

const fieldsOf = (def: RegisterDef, e: Entry) => Object.fromEntries(def.fields.map((x) => [x.k, e[x.k] ?? '']));
