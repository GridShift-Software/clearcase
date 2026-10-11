// User work of the bundle views (GRS-19), all in app().userWork:
// - table bundles_schedule_mark (case scope, key case_id + locator): the Discovery Schedule's selection and
//   Copy/Original marks per file, keyed by the decoded locator path (v5 ess_dcs_schedule_sel_v1 and _co_v1). A
//   defined table, not register_row, because the key must be unique per file: two register rows for one locator
//   could disagree, and register_row cannot enforce that.
// - register store discovery-mode: one row {mode} (v5 ess_dcs_schedule_mode_v1).
// - register store bundle-header: one row of the 8 index header fields (v5 ess_dcs_bundle_header_v2).
// - register store caselines-links: {path, seq} per linked file (v5 ess_dcs_caselines_docs_v1).
// - table bundles_custom (case scope, key case_id + id): the bundles saved from the builder (v5
//   ess_dcs_custom_bundles_v1), keyed by the id of the builder output they were saved from, so saving one output
//   twice updates its entry (S-court_bundle_tab-12). `no` is C<i>, `rows` the v5 rows as JSON, `seq` the list order.
// Every write runs in one in-process queue per case and store (serial), re-reading what it changes just before it
// writes; a form sends the fields-hash of what it loaded, and a write over another tab's change is refused (409).
import { createHash } from 'node:crypto';
import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '../../local-case/app.server.ts';
import { UserWorkError, type RegisterRow, type RegisterValue } from '../../local-case/user-work.server.ts';
import type { CO, Mode } from './discovery.ts';
import { customOf, nextCustomNo, type Custom } from '../../bundles/builder.ts';

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

// One server process serves a data directory, so this queue orders every tab's CC-09 writes of a case and store. A
// write outside it (a user-work restore, another process on the same store) is not ordered by it.
const queues = new Map<string, Promise<unknown>>();
/** Run `fn` after every earlier CC-09 write of the same case and store (a failed write does not block the queue). */
export function serial<T>(caseId: string, store: string, fn: () => Promise<T>): Promise<T> {
	const key = JSON.stringify([caseId, store]);
	const run = (queues.get(key) ?? Promise.resolve()).then(fn);
	const tail = run.then(() => undefined, () => undefined);
	queues.set(key, tail);
	void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
	return run;
}

/** The fields-hash a form sends back: of the stored fields, not updatedAt (which never changes under CLEARCASE_FIXED_NOW). */
export const fieldsHash = (fields: unknown): string => createHash('sha256').update(JSON.stringify(fields ?? null)).digest('hex').slice(0, 24);

/** One file of a mark action: its locator and, for a Copy/Original change, the mark this tab last saw stored. */
export interface MarkChange { locator: string; base?: CO | null }
export interface MarkResult { saved: string[]; conflicts: { locator: string; stored: CO | null }[] }
/** A multi-file write a busy store interrupted after `saved` files were written (each file is its own transaction). */
export class PartialWrite extends Error {
	readonly saved: string[];
	readonly reason: unknown;
	constructor(saved: string[], reason: unknown) { super('partly saved'); this.saved = saved; this.reason = reason; }
}

/**
 * Set `selected` or `co` on each locator, in the marks queue: the rows are re-read just before the write and only that
 * column changes, so a tick and an O on one file both survive. A Copy/Original change on a file another tab set to the
 * other mark since this tab saw it (stored is neither `base` nor the new mark) refuses the whole action, with nothing
 * written (`conflicts`). The user-work API has no multi-row transaction for a defined table, so each file is its own
 * transaction: a busy store part-way throws PartialWrite naming the files already written.
 */
export function writeMarks(caseId: string, changes: readonly MarkChange[], patch: { selected: boolean } | { co: CO }): Promise<MarkResult> {
	return serial(caseId, MARK_TABLE, async () => {
		const cur = new Map((await readMarks(caseId)).map((m) => [m.locator, m]));
		const uw = app().userWork;
		const seen = new Set<string>();
		const list = changes.filter((c) => !seen.has(c.locator) && !!seen.add(c.locator));
		if ('co' in patch) {
			const conflicts = list.filter((c) => c.base !== undefined).map((c) => ({ locator: c.locator, stored: cur.get(c.locator)?.co ?? null, base: c.base }))
				.filter((c) => c.stored !== c.base && c.stored !== patch.co).map(({ locator, stored }) => ({ locator, stored }));
			if (conflicts.length) return { saved: [], conflicts };
		}
		const saved: string[] = [];
		try {
			for (const { locator } of list) {
				const old = cur.get(locator) ?? { locator, selected: false, co: null };
				const next = { ...old, ...patch };
				if (next.selected !== old.selected || next.co !== old.co) {
					if (!next.selected && !next.co) await uw.deleteTableRow(MARK_TABLE, { case_id: caseId, locator }, { owner: OWNER });
					else await uw.putTableRow(MARK_TABLE, { case_id: caseId, locator, selected: next.selected ? 1 : 0, co: next.co }, { owner: OWNER });
				}
				saved.push(locator);
			}
		} catch (e) {
			if (saved.length) throw new PartialWrite(saved, e);
			throw e;
		}
		return { saved, conflicts: [] };
	});
}

export const CUSTOM_TABLE = 'bundles_custom';
let customDefined: Promise<void> | null = null;
export function customTable(): Promise<void> {
	customDefined ??= app().userWork.defineTable({
		name: CUSTOM_TABLE, owner: OWNER, scope: 'case',
		description: 'Court bundles saved from the bundle builder: number, name, page counts and item list, keyed by the builder output they were saved from (GRS-19)',
		columns: [
			{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'id', type: 'TEXT', notNull: true }, { name: 'no', type: 'TEXT', notNull: true }, { name: 'name', type: 'TEXT' },
			{ name: 'pages', type: 'INTEGER' }, { name: 'index_pages', type: 'INTEGER' }, { name: 'file_pages', type: 'INTEGER' }, { name: 'note', type: 'TEXT' }, { name: 'rows', type: 'TEXT' }, { name: 'seq', type: 'INTEGER' },
		],
		primaryKey: ['case_id', 'id'],
	}).catch((e) => { customDefined = null; throw e; });
	return customDefined;
}
export type SavedCustom = Custom & { id: string; seq: number };
/** The saved bundles in list order; a row whose fields do not read as a bundle is left out. */
export async function readCustom(caseId: string): Promise<SavedCustom[]> {
	await customTable();
	const out: SavedCustom[] = [];
	for (const r of app().userWork.listTableRows(CUSTOM_TABLE, { caseId })) {
		let rows: unknown = [];
		try { rows = JSON.parse(String(r.rows ?? '[]')); } catch { rows = []; }
		const c = customOf({ no: r.no, name: r.name, pages: r.pages, indexPages: r.index_pages, filePages: r.file_pages, note: r.note, rows });
		if (c) out.push({ ...c, id: String(r.id), seq: Number(r.seq) || 0 });
	}
	return out.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
}
/** Save `c` under the builder output `id` in the custom queue: an existing entry keeps its number and place; a new
 * one takes the lowest free C<i> (none of the saved or `shipped` numbers) and goes last. Returns its number. */
export function saveCustom(caseId: string, id: string, c: Omit<Custom, 'no'>, shipped: readonly { no: string }[]): Promise<string> {
	return serial(caseId, CUSTOM_TABLE, async () => {
		const cur = await readCustom(caseId);
		const old = cur.find((x) => x.id === id);
		const no = old?.no ?? nextCustomNo(cur, shipped);
		const seq = old?.seq ?? Math.max(0, ...cur.map((x) => x.seq)) + 1;
		await app().userWork.putTableRow(CUSTOM_TABLE, { case_id: caseId, id, no, name: c.name, pages: c.pages, index_pages: c.indexPages, file_pages: c.filePages, note: c.note, rows: JSON.stringify(c.rows), seq }, { owner: OWNER });
		return no;
	});
}
/** Remove the saved bundle of output `id` (no document is deleted); removing one already gone is not an error. */
export const deleteCustom = (caseId: string, id: string) => serial(caseId, CUSTOM_TABLE, async () => {
	await customTable();
	await app().userWork.deleteTableRow(CUSTOM_TABLE, { case_id: caseId, id }, { owner: OWNER });
});

/** A one-row register store: its single row (the first by seq, then id), or null. */
export function singleRow(caseId: string, store: string): RegisterRow | null {
	return app().userWork.listRows(caseId, store)[0] ?? null;
}
/** The fields-hash of a one-row store as a form loads it ('' fields for no row). */
export const singleHash = (caseId: string, store: string) => fieldsHash(singleRow(caseId, store)?.fields ?? null);
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

/** Add one CaseLines link in the links queue: its seq is computed there, so links saved together keep their order. */
export const addLink = (caseId: string, path: string) => serial(caseId, LINKS_STORE, async () => {
	const seq = Math.max(0, ...app().userWork.listRows(caseId, LINKS_STORE).map((r) => Number(r.fields.seq) || 0)) + 1;
	return app().userWork.putRow(caseId, LINKS_STORE, null, { path, seq });
});

export const busyMessage = (e: unknown) => `the case store is busy (${isHttpError(e) ? e.body.message : 'locked'})`;

/**
 * Run a user-work write for a form action. A busy store (503 after the store's retries) or a refused write returns
 * `fail` with the user's values, so the page keeps the input and shows the error. A single write is one transaction,
 * so it is saved or not; a multi-file write reports the files it saved (PartialWrite), never "Not saved" after a part.
 */
export async function guarded<T>(values: Record<string, unknown>, fn: () => Promise<T>) {
	try { return await fn(); }
	catch (e) {
		if (e instanceof PartialWrite) {
			// the store's own busy message says "nothing was written", which is true of that one file only
			const why = isHttpError(e.reason) && e.reason.status === 503 ? 'the case store was busy (another process holds it)' : e.reason instanceof UserWorkError ? `a write was refused (${e.reason.message})` : 'a write failed';
			return fail(503, { message: `Partly saved: ${e.saved.length} file${e.saved.length === 1 ? '' : 's'} saved, then ${why}. The rest are not saved; Retry saves them.`, saved: e.saved, values });
		}
		if (isHttpError(e) && e.status === 503) return fail(503, { message: `Not saved: ${busyMessage(e)}. Your input is kept; try again.`, values });
		if (e instanceof UserWorkError) return fail(400, { message: `Not saved: ${e.message}`, values });
		throw e;
	}
}
