// Server side of the seven register pages (GRS-17): the load and the save/delete actions every route re-exports with
// its view id. Rows are scoped to the version's case and kept apart from imported results. A refused save returns
// fail(<status>, {op: 'save', values, rowId, version, message, retry}) so the form keeps every typed value, with or
// without JavaScript; a refused delete returns fail(<status>, {op: 'delete', rowId, message}). Nothing throws to the
// error page. A success never returns a `rowId`: the page enters edit mode only from a refused edit.
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { DocumentAnchor } from '../../case-package/index.ts';
import { now } from '../../components/clock.ts';
import { viewAt } from '../../components/views.ts';
import { app } from '../../local-case/app.server.ts';
import { resolveRefs } from '../../local-case/documents.server.ts';
import { exportFileName, viewContentOf, viewText } from '../../local-case/results.server.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { addEntry, deleteEntry, editEntry, listRegister, type StoredRow } from '../../user-work/registers.server.ts';
import { parseAmount } from './amounts.ts';
import { registerOf, type RegisterDef, type RegisterView } from './defs.ts';
import { byDate, cellText, countdown, entryFrom, invalidReason, timesheetValue, unsavable, type Entry, type Tone } from './logic.ts';

/** A table cell; `flag` marks a stored value the amount grammar refuses (shown as typed, not counted). */
export type Cell = { kind: 'text'; text: string; flag?: string } | { kind: 'chip'; text: string; tone: Tone } | { kind: 'ref'; text: string; target: string | null };
/** A shown row: `version` goes back with an edit (a stale edit is refused); `intact` is false when altered on disk. */
export interface ShownRow { rowId: string; values: Entry; cells: Cell[]; version: string; intact: boolean }

/** Where each typed document ref leads in this version: a link to the anchored or exactly named document, or none. */
function refTargets(a: LocalCase, rv: string, rows: readonly StoredRow[], def: RegisterDef): Map<string, string | null> {
	const refField = def.fields.find((x) => x.docRef)?.k;
	const out = new Map<string, string | null>();
	if (!refField) return out;
	const typed = [...new Set(rows.map((r) => r.values[refField]!).filter(Boolean))];
	const known = resolveRefs(a.store, rv, typed);
	let fps: ReturnType<LocalCase['store']['fingerprints']> | undefined;
	for (const r of rows) {
		const ref = r.values[refField]!;
		if (!ref) continue;
		let target: string | null = known.has(ref) ? ref : null;
		// an anchor made in another version follows its original's fingerprint, exactly; an ambiguous, missing or
		// unfingerprinted anchor is not guessed (the ref renders broken: a reused ref is not proof of identity across
		// versions), and a ref that names nothing is never fuzzy-matched
		if (r.anchor && r.anchor.resultsVersion !== rv) {
			const m = a.userWork.resolve(r.anchor, rv, (fps ??= a.store.fingerprints(rv)));
			target = m.status === 'exact' ? m.refs[0]! : m.status === 'here' ? ref : null;
		}
		out.set(r.rowId, target);
	}
	return out;
}

function cells(def: RegisterDef, r: StoredRow, targets: Map<string, string | null>, at: Date): Cell[] {
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

/**
 * The anchor for a typed ref that names an imported document of this version, else none (the ref is kept as typed).
 * `cur` is the row being edited: while its ref is unchanged it keeps its own anchor, made in whichever version.
 */
function anchorOf(a: LocalCase, def: RegisterDef, caseId: string, rv: string, e: Entry, cur?: StoredRow): DocumentAnchor | null {
	const k = def.fields.find((x) => x.docRef)?.k ?? '';
	const ref = e[k];
	if (cur && (cur.values[k] ?? '') === (ref ?? '')) return cur.anchor;
	if (!ref || !a.store.existingRefs(rv, [ref]).has(ref)) return null;
	return a.userWork.anchorFor(caseId, rv, ref);
}

export function registerLoad(view: RegisterView) {
	const def = registerOf(view);
	return async ({ parent }: { parent: () => Promise<{ version: { id: string; caseId: string } }> }) => {
		const { version } = await parent();
		const a = app();
		const stored = listRegister(a.userWork, version.caseId, def);
		const targets = refTargets(a, version.id, stored, def);
		const at = now();
		const shown = view === 'deadlines_tab' ? byDate(stored) : stored;
		// the calendar's file name and PRODID are case content v5 hard-coded in its export: read from the package's
		// view-content, else the neutral name with a note beside the export (the six ledgers keep their neutral names)
		const vc = view === 'deadlines_tab' ? viewContentOf(a.store, version.id) : null;
		return {
			register: { view, label: viewAt('registers', view)!.label, subtitle: def.subtitle, empty: def.empty, fields: def.fields, columns: def.columns, export: def.export, keepAfterAdd: def.keepAfterAdd ?? [], required: def.required ?? null },
			rows: shown.map((r): ShownRow => ({ rowId: r.rowId, values: r.values, cells: cells(def, r, targets, at), version: r.version, intact: r.intact })),
			/** stored order, for the exports (v5 exports its store, not the shown order) */
			exportRows: stored.map((r) => ({ rowId: r.rowId, values: r.values })),
			exportName: vc ? exportFileName(vc, 'deadlines_tab', def.export.name) : { name: def.export.name, note: null },
			icsProductId: vc ? viewText(vc, 'deadlines_tab', 'icsProductId') : null,
		};
	};
}

const statusOf = (e: unknown): number => { const s = (e as { status?: unknown })?.status; return typeof s === 'number' && s >= 400 && s < 600 ? s : 500; };
const failure = (e: unknown, what: string) => {
	const status = statusOf(e);
	const invalid = (e as { code?: string })?.code === 'invalid';
	const why = status === 503 ? 'the store is busy or unavailable' : invalid ? 'the entry is larger than the 64 KiB a register entry can hold, or not valid' : 'the store refused the write';
	const s = status === 500 && invalid ? 400 : status;
	return { status: s, message: `${what} was not saved: ${why}. Nothing was changed; ${s >= 500 ? 'try again' : 'your input is kept'}.`, retry: s >= 500 };
};
const GONE = 'This entry was deleted elsewhere (in another tab or window), so your change was not saved. Your input is kept: copy it, then Discard and add it again.';
const STALE = 'This entry was changed elsewhere (in another tab or window) since you opened it, so your change was not saved. Your input is kept and the list shows the entry as it is now: copy what you need, Discard, then edit the entry again.';

function caseOf(params: Record<string, string>): { caseId: string; rv: string } | null {
	const v = app().store.getVersion(params.vid ?? '');
	return v ? { caseId: v.case_id, rv: v.id } : null;
}

export function registerActions(view: RegisterView) {
	const def = registerOf(view);
	return {
		save: async ({ params, request }: RequestEvent) => {
			const f = await request.formData();
			const values = entryFrom(def, Object.fromEntries(def.fields.map((x) => [x.k, f.get(x.k)])));
			const str = (k: string) => { const v = f.get(k); return typeof v === 'string' && v ? v : null; };
			const rowId = str('rowId'), version = str('version');
			const refuse = (status: number, message: string, retry = false) => fail(status, { op: 'save' as const, values, rowId, version, message, retry });
			const c = caseOf(params);
			if (!c) return refuse(404, 'Unknown results version.');
			const skip = unsavable(def, values, rowId !== null);
			if (skip === '') return { saved: false };
			if (skip) return refuse(400, skip);
			const bad = invalidReason(def, values);
			if (bad) return refuse(400, bad);
			// an edit names the version it was made from; one without (not from this page) cannot be checked, so it is refused
			if (rowId && !version) return refuse(409, STALE);
			const a = app();
			try {
				if (rowId) {
					// read inside the serialized edit: the row's current anchor, not the page's copy
					const r = await editEntry(a.userWork, c.caseId, def, rowId, values, (cur) => anchorOf(a, def, c.caseId, c.rv, values, cur), version);
					return r === 'saved' ? { saved: true } : refuse(r === 'gone' ? 404 : 409, r === 'gone' ? GONE : STALE);
				}
				return { saved: true, savedId: await addEntry(a.userWork, c.caseId, def, values, anchorOf(a, def, c.caseId, c.rv, values)) };
			} catch (e) {
				const x = failure(e, rowId ? 'The change' : 'The entry');
				return refuse(x.status, x.message, x.retry);
			}
		},
		delete: async ({ params, request }: RequestEvent) => {
			const f = await request.formData();
			const rowId = f.get('rowId');
			const c = caseOf(params);
			if (!c) return fail(404, { op: 'delete' as const, rowId: null, message: 'Unknown results version.' });
			if (typeof rowId !== 'string' || !rowId) return fail(400, { op: 'delete' as const, rowId: null, message: 'No entry was named.' });
			try {
				return { deleted: await deleteEntry(app().userWork, c.caseId, def, rowId) };
			} catch (e) {
				const x = failure(e, 'The deletion');
				return fail(x.status, { op: 'delete' as const, rowId, message: x.message.replace('was not saved', 'did not happen').replace('try again', 'the entry is still there; try again') });
			}
		},
	};
}
