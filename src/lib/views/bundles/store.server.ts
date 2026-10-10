// User work of the bundle views (GRS-19), all in app().userWork:
// - table bundles_schedule_mark (case scope, key case_id + locator): the Discovery Schedule's selection and
//   Copy/Original marks per file, keyed by the decoded locator path (v5 ess_dcs_schedule_sel_v1 and _co_v1). A
//   defined table, not register_row, because the key must be unique per file: two register rows for one locator
//   could disagree, and register_row cannot enforce that.
// - register store discovery-mode: one row {mode} (v5 ess_dcs_schedule_mode_v1).
// - register store bundle-header: one row of the 8 index header fields (v5 ess_dcs_bundle_header_v2).
// - register store caselines-links: {path, seq} per linked file (v5 ess_dcs_caselines_docs_v1).
import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '../../local-case/app.server.ts';
import { UserWorkError, type RegisterRow, type RegisterValue } from '../../local-case/user-work.server.ts';
import type { CO, Mode } from './discovery.ts';

export const OWNER = 'GRS-19';
export const MARK_TABLE = 'bundles_schedule_mark';
let defined: Promise<void> | null = null;
/** Define the mark table once per process. */
export function marksTable(): Promise<void> {
	defined ??= app().userWork.defineTable({
		name: MARK_TABLE, owner: OWNER, scope: 'case',
		description: 'Discovery Schedule selection and Copy/Original marks per schedule file, keyed by its decoded locator path (GRS-19)',
		columns: [{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'locator', type: 'TEXT', notNull: true }, { name: 'selected', type: 'INTEGER' }, { name: 'co', type: 'TEXT' }],
		primaryKey: ['case_id', 'locator'],
	}).catch((e) => { defined = null; throw e; });
	return defined;
}

export interface Mark { locator: string; selected: boolean; co: CO | null }
export async function readMarks(caseId: string): Promise<Mark[]> {
	await marksTable();
	return app().userWork.listTableRows(MARK_TABLE, { caseId }).map((r) => ({ locator: String(r.locator), selected: Number(r.selected) === 1, co: r.co === 'C' || r.co === 'O' ? r.co : null }));
}

/** Set `selected` and/or `co` on each locator; a row with neither is deleted. */
export async function writeMarks(caseId: string, locators: readonly string[], patch: { selected?: boolean; co?: CO }): Promise<void> {
	const cur = new Map((await readMarks(caseId)).map((m) => [m.locator, m]));
	const uw = app().userWork;
	for (const locator of new Set(locators)) {
		const old = cur.get(locator) ?? { locator, selected: false, co: null };
		const next = { ...old, ...(patch.selected !== undefined ? { selected: patch.selected } : {}), ...(patch.co ? { co: patch.co } : {}) };
		if (next.selected === old.selected && next.co === old.co && cur.has(locator)) continue;
		if (!next.selected && !next.co) { if (cur.has(locator)) await uw.deleteTableRow(MARK_TABLE, { case_id: caseId, locator }, { owner: OWNER }); }
		else await uw.putTableRow(MARK_TABLE, { case_id: caseId, locator, selected: next.selected ? 1 : 0, co: next.co }, { owner: OWNER });
	}
}

/** Unselect every file (v5 Clear and Empty bundle), keeping the marks. */
export async function clearSelection(caseId: string): Promise<void> {
	await writeMarks(caseId, (await readMarks(caseId)).filter((m) => m.selected).map((m) => m.locator), { selected: false });
}

/** A one-row register store: its single row (the first by seq, then id), or null. */
export function singleRow(caseId: string, store: string): RegisterRow | null {
	return app().userWork.listRows(caseId, store)[0] ?? null;
}
export async function putSingle(caseId: string, store: string, fields: Record<string, RegisterValue>): Promise<void> {
	const rows = app().userWork.listRows(caseId, store);
	await app().userWork.putRow(caseId, store, rows[0]?.rowId ?? null, fields);
	for (const extra of rows.slice(1)) await app().userWork.deleteRow(caseId, store, extra.rowId);
}
export async function deleteSingle(caseId: string, store: string): Promise<void> {
	for (const r of app().userWork.listRows(caseId, store)) await app().userWork.deleteRow(caseId, store, r.rowId);
}

export const MODE_STORE = 'discovery-mode';
export const LINKS_STORE = 'caselines-links';
export const HEADER_STORE = 'bundle-header';
export const readMode = (caseId: string): Mode => (singleRow(caseId, MODE_STORE)?.fields.mode === 'supplementary' ? 'supplementary' : 'discovery');

/**
 * Run a user-work write for a form action. A busy store (503 after the store's retries) or a refused write returns
 * `fail` with the user's values, so the page keeps the input and shows the error; nothing is half-saved.
 */
export async function guarded<T>(values: Record<string, unknown>, fn: () => Promise<T>) {
	try { return await fn(); }
	catch (e) {
		if (isHttpError(e) && e.status === 503) return fail(503, { message: `Not saved: the case store is busy (${e.body.message}). Your input is kept; try again.`, values });
		if (e instanceof UserWorkError) return fail(400, { message: `Not saved: ${e.message}`, values });
		throw e;
	}
}
