// Server side of the seven register pages (GRS-17): the load and the save/delete actions every route re-exports with
// its view id. Rows are scoped to the version's case and kept apart from imported results. A failed write returns
// fail(<status>, {values, rowId, message}) so the form keeps every typed value; it never throws to the error page.
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { DocumentAnchor } from '../../case-package/index.ts';
import { now } from '../../components/clock.ts';
import { viewAt } from '../../components/views.ts';
import { app } from '../../local-case/app.server.ts';
import { documentRowProviders, documentRows } from '../../local-case/documents.server.ts';
import { viewContentOf, viewText } from '../../local-case/results.server.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { addEntry, deleteEntry, editEntry, listRegister, type StoredRow } from '../../user-work/registers.server.ts';
import { registerOf, type RegisterDef, type RegisterView } from './defs.ts';
import { byDate, cellText, countdown, entryFrom, invalidReason, isSkipped, type Entry, type Tone } from './logic.ts';

export type Cell = { kind: 'text'; text: string } | { kind: 'chip'; text: string; tone: Tone } | { kind: 'ref'; text: string; target: string | null };
export interface ShownRow { rowId: string; values: Entry; cells: Cell[] }

/** Where each typed document ref leads in this version: a link to the anchored or exactly named document, or none. */
function refTargets(a: LocalCase, rv: string, rows: readonly StoredRow[], def: RegisterDef): Map<string, string | null> {
	const refField = def.fields.find((x) => x.docRef)?.k;
	const out = new Map<string, string | null>();
	if (!refField) return out;
	const typed = [...new Set(rows.map((r) => r.values[refField]!).filter(Boolean))];
	const imported = a.store.existingRefs(rv, typed);
	const provided = typed.some((t) => !imported.has(t)) && documentRowProviders().length ? new Set(documentRows(a.store, rv).rows.map((r) => r.ref)) : new Set<string>();
	let fps: ReturnType<LocalCase['store']['fingerprints']> | undefined;
	for (const r of rows) {
		const ref = r.values[refField]!;
		if (!ref) continue;
		let target: string | null = imported.has(ref) || provided.has(ref) ? ref : null;
		// an anchor made in another version follows its original's fingerprint, exactly; an ambiguous or missing match
		// is not guessed (the ref renders broken), and a ref that names nothing is never fuzzy-matched
		if (r.anchor && r.anchor.resultsVersion !== rv && r.anchor.sha256) {
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
		return { kind: 'text', text: cellText(c.kind, r.values, c.field) };
	});
}

/** The anchor for a typed ref that names an imported document of this version, else none (the ref is kept as typed). */
function anchorOf(a: LocalCase, def: RegisterDef, caseId: string, rv: string, e: Entry): DocumentAnchor | null {
	const ref = e[def.fields.find((x) => x.docRef)?.k ?? ''];
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
		return {
			register: { view, label: viewAt('registers', view)!.label, subtitle: def.subtitle, empty: def.empty, fields: def.fields, columns: def.columns, export: def.export, keepAfterAdd: def.keepAfterAdd ?? [], required: def.required ?? null },
			rows: shown.map((r): ShownRow => ({ rowId: r.rowId, values: r.values, cells: cells(def, r, targets, at) })),
			/** stored order, for the exports (v5 exports its store, not the shown order) */
			exportRows: stored.map((r) => ({ rowId: r.rowId, values: r.values })),
			icsProductId: view === 'deadlines_tab' ? viewText(viewContentOf(a.store, version.id), 'deadlines_tab', 'icsProductId') : null,
		};
	};
}

const statusOf = (e: unknown): number => { const s = (e as { status?: unknown })?.status; return typeof s === 'number' && s >= 400 && s < 600 ? s : 500; };
const failure = (e: unknown, what: string) => {
	const status = statusOf(e);
	const why = status === 503 ? 'the store is busy or unavailable' : (e as { code?: string })?.code === 'invalid' ? 'the entry is too large or not valid' : 'the store refused the write';
	return { status: status === 500 && (e as { code?: string })?.code === 'invalid' ? 400 : status, message: `${what} was not saved: ${why}. Nothing was changed; try again.` };
};

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
			const rowId = typeof f.get('rowId') === 'string' && f.get('rowId') ? (f.get('rowId') as string) : null;
			const c = caseOf(params);
			if (!c) return fail(404, { values, rowId, message: 'Unknown results version.' });
			if (isSkipped(def, values)) return { saved: false, rowId };
			const bad = invalidReason(def, values);
			if (bad) return fail(400, { values, rowId, message: bad });
			const a = app();
			try {
				const anchor = anchorOf(a, def, c.caseId, c.rv, values);
				if (rowId) {
					if (!(await editEntry(a.userWork, c.caseId, def, rowId, values, anchor))) return fail(404, { values, rowId, message: 'This entry no longer exists; it was not saved. Copy your input and add it again.' });
					return { saved: true, rowId };
				}
				return { saved: true, rowId: await addEntry(a.userWork, c.caseId, def, values, anchor) };
			} catch (e) {
				const x = failure(e, rowId ? 'The change' : 'The entry');
				return fail(x.status, { values, rowId, message: x.message });
			}
		},
		delete: async ({ params, request }: RequestEvent) => {
			const f = await request.formData();
			const rowId = f.get('rowId');
			const c = caseOf(params);
			if (!c) return fail(404, { message: 'Unknown results version.' });
			if (typeof rowId !== 'string' || !rowId) return fail(400, { message: 'No entry was named.' });
			try {
				return { deleted: await deleteEntry(app().userWork, c.caseId, def, rowId) };
			} catch (e) {
				const x = failure(e, 'The deletion');
				return fail(x.status, { message: x.message.replace('was not saved', 'did not happen') });
			}
		},
	};
}
