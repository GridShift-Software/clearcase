import { createHash } from 'node:crypto';
import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '../../local-case/app.server.ts';
import { inTurn } from '../../local-case/registers.server.ts';
import { UserWorkError, type RegisterRow, type RegisterValue } from '../../local-case/user-work.server.ts';
import type { CO, Mode } from './discovery.ts';
import { customOf, nextCustomNo, type Custom } from '../../bundles/builder.ts';

export const OWNER = 'GRS-19';
export const MARK_TABLE = 'bundles_schedule_mark';
let defined: Promise<void> | null = null;
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

export const serial = <T>(caseId: string, store: string, fn: () => Promise<T>): Promise<T> => inTurn(app().userWork, caseId, store, fn);

export const fieldsHash = (fields: unknown): string => createHash('sha256').update(JSON.stringify(fields ?? null)).digest('hex').slice(0, 24);

export interface MarkChange { locator: string; base?: CO | null }
export interface MarkResult { saved: string[]; conflicts: { locator: string; stored: CO | null }[] }
export class PartialWrite extends Error {
	readonly saved: string[];
	readonly reason: unknown;
	constructor(saved: string[], reason: unknown) { super('partly saved'); this.saved = saved; this.reason = reason; }
}

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
export function importCustom(caseId: string, list: readonly (Custom & { id: string })[]): Promise<number> {
	return serial(caseId, CUSTOM_TABLE, async () => {
		const cur = await readCustom(caseId);
		let seq = Math.max(0, ...cur.map((x) => x.seq));
		await app().userWork.putTableRows(CUSTOM_TABLE, list.map((c) => ({ case_id: caseId, id: c.id, no: c.no, name: c.name, pages: c.pages, index_pages: c.indexPages, file_pages: c.filePages, note: c.note, rows: JSON.stringify(c.rows), seq: cur.find((x) => x.id === c.id)?.seq ?? ++seq })), { owner: OWNER });
		return list.length;
	});
}
export const deleteCustom = (caseId: string, id: string) => serial(caseId, CUSTOM_TABLE, async () => {
	await customTable();
	await app().userWork.deleteTableRow(CUSTOM_TABLE, { case_id: caseId, id }, { owner: OWNER });
});

export function singleRow(caseId: string, store: string): RegisterRow | null {
	return app().userWork.listRows(caseId, store)[0] ?? null;
}
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

export const addLink = (caseId: string, path: string) => serial(caseId, LINKS_STORE, async () => {
	const seq = Math.max(0, ...app().userWork.listRows(caseId, LINKS_STORE).map((r) => Number(r.fields.seq) || 0)) + 1;
	return app().userWork.putRow(caseId, LINKS_STORE, null, { path, seq });
});

export const busyMessage = (e: unknown) => `the case store is busy (${isHttpError(e) ? e.body.message : 'locked'})`;

export async function guarded<T>(values: Record<string, unknown>, fn: () => Promise<T>) {
	try { return await fn(); }
	catch (e) {
		if (e instanceof PartialWrite) {
			const why = isHttpError(e.reason) && e.reason.status === 503 ? 'the case store was busy (another process holds it)' : e.reason instanceof UserWorkError ? `a write was refused (${e.reason.message})` : 'a write failed';
			return fail(503, { message: `Partly saved: ${e.saved.length} file${e.saved.length === 1 ? '' : 's'} saved, then ${why}. The rest are not saved; Retry saves them.`, saved: e.saved, values });
		}
		if (isHttpError(e) && e.status === 503) return fail(503, { message: `Not saved: ${busyMessage(e)}. Your input is kept; try again.`, values });
		if (e instanceof UserWorkError) return fail(400, { message: `Not saved: ${e.message}`, values });
		throw e;
	}
}
