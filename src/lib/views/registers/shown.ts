// What the local and the hosted register pages share: the page's data shape, the table cells, and the checks an action makes
// before it writes. Neither reads storage here, so a hosted route may import it.
import { fail } from '@sveltejs/kit';
import { CANCEL, deleteStep } from '../../components/confirm-delete.ts';
import { viewAt } from '../../components/views.ts';
import { parseAmount } from './amounts.ts';
import { type RegisterDef, type RegisterView } from './defs.ts';
import { cellText, countdown, entryFrom, invalidReason, timesheetValue, unsavable, type Entry, type Row, type Tone } from './logic.ts';

export type Cell = { kind: 'text'; text: string; flag?: string } | { kind: 'chip'; text: string; tone: Tone } | { kind: 'ref'; text: string; target: string | null };
export interface ShownRow { rowId: string; values: Entry; cells: Cell[]; version: string; intact: boolean }
/** A register row as the page reads it: the entry's values and the row's version, whichever store it came from. */
export interface RowView extends Row { version: string; intact: boolean }

export function registerHead(view: RegisterView, def: RegisterDef) {
	return { view, label: viewAt('registers', view)!.label, subtitle: def.subtitle, empty: def.empty, fields: def.fields, columns: def.columns, export: def.export, keepAfterAdd: def.keepAfterAdd ?? [], required: def.required ?? null };
}

export function cells(def: RegisterDef, r: Row, targets: Map<string, string | null>, at: Date): Cell[] {
	return def.columns.map((c): Cell => {
		const v = c.field ? (r.values[c.field] ?? '') : '';
		if (c.kind === 'countdown') return { kind: 'chip', ...countdown(v, at) };
		if (c.kind === 'category') return { kind: 'chip', text: cellText(c.kind, r.values, c.field), tone: 'info' };
		if (c.kind === 'ref' && v) { const t = targets.get(r.rowId); return { kind: 'ref', text: v, target: t ?? null }; }
		const kind = c.field ? def.fields.find((x) => x.k === c.field)?.amount : undefined;
		const bad = kind ? parseAmount(v, kind).kind === 'bad' : c.kind === 'value' && timesheetValue(r.values) === '';
		return bad ? { kind: 'text', text: cellText(c.kind, r.values, c.field), flag: 'not a number; not counted' } : { kind: 'text', text: cellText(c.kind, r.values, c.field) };
	});
}

export const shownRows = (def: RegisterDef, rows: readonly RowView[], targets: Map<string, string | null>, at: Date): ShownRow[] =>
	rows.map((r): ShownRow => ({ rowId: r.rowId, values: r.values, cells: cells(def, r, targets, at), version: r.version, intact: r.intact }));

export const GONE = 'This entry was deleted elsewhere (in another tab or window), so your change was not saved. Your input is kept: copy it, then Discard and add it again.';
export const STALE = 'This entry was changed elsewhere (in another tab or window) since you opened it, so your change was not saved. Your input is kept and the list shows the entry as it is now: copy what you need, Discard, then edit the entry again.';
export const STALE_DELETE = 'This entry was changed elsewhere (in another tab or window) since you opened it, so it was not deleted. The list shows the entry as it is now; delete it again if you still want it gone.';

const statusOf = (e: unknown): number => { const s = (e as { status?: unknown })?.status; return typeof s === 'number' && s >= 400 && s < 600 ? s : 500; };
export const failure = (e: unknown, what: string) => {
	const status = statusOf(e);
	const invalid = (e as { code?: string })?.code === 'invalid';
	const why = status === 503 ? 'the store is busy or unavailable' : invalid ? 'the entry is larger than the 64 KiB a register entry can hold, or not valid' : 'the store refused the write';
	const s = status === 500 && invalid ? 400 : status;
	return { status: s, message: `${what} was not saved: ${why}. Nothing was changed; ${s >= 500 ? 'try again' : 'your input is kept'}.`, retry: s >= 500 };
};
export const deletionFailure = (message: string) => message.replace('was not saved', 'did not happen').replace('try again', 'the entry is still there; try again');

/** The submitted entry, and the failure to return for it: every refusal of a save keeps the input and the row it edits. */
export function readSave(def: RegisterDef, f: FormData) {
	const values = entryFrom(def, Object.fromEntries(def.fields.map((x) => [x.k, f.get(x.k)])));
	const str = (k: string) => { const v = f.get(k); return typeof v === 'string' && v ? v : null; };
	const rowId = str('rowId'), version = str('version');
	const refuse = (status: number, message: string, retry = false) => fail(status, { op: 'save' as const, values, rowId, version, message, retry });
	return { values, rowId, version, operationId: str('operationId'), refuse };
}

/** What a save refuses before it touches a store: an empty entry is skipped, an invalid one refused, an edit without its version too. */
export function checkSave(def: RegisterDef, s: ReturnType<typeof readSave>) {
	const skip = unsavable(def, s.values, s.rowId !== null);
	if (skip === '') return { saved: false };
	if (skip) return s.refuse(400, skip);
	const bad = invalidReason(def, s.values);
	if (bad) return s.refuse(400, bad);
	if (s.rowId && !s.version) return s.refuse(409, STALE);
	return null;
}

/** The delete form: the row named, and the entry in the form so a refusal keeps what was typed. */
export function readDelete(def: RegisterDef, f: FormData) {
	const named = f.get('delete') ?? f.get(CANCEL) ?? f.get('rowId');
	const rowId = typeof named === 'string' && named ? named : null;
	const draft = def.fields.some((x) => f.has(x.k))
		? { values: entryFrom(def, Object.fromEntries(def.fields.map((x) => [x.k, f.get(x.k)]))) }
		: {};
	const v = f.get('deleteVersion');
	return { rowId, draft, version: typeof v === 'string' && v ? v : null };
}

/** A Delete that is not confirmed deletes nothing: the page asks for the confirmation (none after Cancel). */
export function checkDelete(f: FormData, rowId: string | null, draft: object) {
	if (!rowId) return fail(400, { op: 'delete' as const, rowId: null, ...draft, message: 'No entry was named.' });
	const step = deleteStep(f, rowId);
	if (step !== 'confirm') return fail(400, { op: 'delete' as const, rowId, ...draft, confirm: step === 'ask' ? rowId : null });
	return null;
}
