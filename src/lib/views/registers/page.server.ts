import { fail, type RequestEvent } from '@sveltejs/kit';
import type { DocumentAnchor } from '../../case-package/index.ts';
import { fixedNowSetting, now } from '../../components/clock.ts';
import { app } from '../../local-case/app.server.ts';
import { resolveRefs } from '../../local-case/documents.server.ts';
import { exportFileName, viewContentOf, viewText } from '../../local-case/results.server.ts';
import type { LocalCase } from '../../local-case/service.server.ts';
import { addEntry, deleteEntry, editEntry, listRegister, type StoredRow } from '../../user-work/registers.server.ts';
import { registerOf, type RegisterDef, type RegisterView } from './defs.ts';
import { byDate, type Entry } from './logic.ts';
import { checkDelete, checkSave, deletionFailure, failure, GONE, readDelete, readSave, registerHead, shownRows, STALE } from './shown.ts';

export type { Cell, ShownRow } from './shown.ts';

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
		if (r.anchor && r.anchor.resultsVersion !== rv) {
			const m = a.userWork.resolve(r.anchor, rv, (fps ??= a.store.fingerprints(rv)));
			target = m.status === 'exact' ? m.refs[0]! : m.status === 'here' ? ref : null;
		}
		out.set(r.rowId, target);
	}
	return out;
}

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
		const vc = view === 'deadlines_tab' ? viewContentOf(a.store, version.id) : null;
		return {
			register: registerHead(view, def),
			rows: shownRows(def, shown, targets, at),
			exportRows: stored.map((r) => ({ rowId: r.rowId, values: r.values })),
			exportName: vc ? exportFileName(vc, 'deadlines_tab', def.export.name) : { name: def.export.name, note: null },
			icsProductId: vc ? viewText(vc, 'deadlines_tab', 'icsProductId') : null,
			fixedNow: fixedNowSetting() ? at.toISOString() : null,
		};
	};
}

function caseOf(params: Record<string, string>): { caseId: string; rv: string } | null {
	const v = app().store.getVersion(params.vid ?? '');
	return v ? { caseId: v.case_id, rv: v.id } : null;
}

export function registerActions(view: RegisterView) {
	const def = registerOf(view);
	return {
		save: async ({ params, request }: RequestEvent) => {
			const s = readSave(def, await request.formData());
			const { values, rowId, version } = s;
			const c = caseOf(params);
			if (!c) return s.refuse(404, 'Unknown results version.');
			const refused = checkSave(def, s);
			if (refused) return refused;
			const a = app();
			try {
				if (rowId) {
					const r = await editEntry(a.userWork, c.caseId, def, rowId, values, (cur) => anchorOf(a, def, c.caseId, c.rv, values, cur), version);
					return r === 'saved' ? { saved: true } : s.refuse(r === 'gone' ? 404 : 409, r === 'gone' ? GONE : STALE);
				}
				return { saved: true, savedId: await addEntry(a.userWork, c.caseId, def, values, anchorOf(a, def, c.caseId, c.rv, values)) };
			} catch (e) {
				const x = failure(e, rowId ? 'The change' : 'The entry');
				return s.refuse(x.status, x.message, x.retry);
			}
		},
		delete: async ({ params, request }: RequestEvent) => {
			const f = await request.formData();
			const { rowId, draft } = readDelete(def, f);
			const c = caseOf(params);
			if (!c) return fail(404, { op: 'delete' as const, rowId: null, ...draft, message: 'Unknown results version.' });
			const refused = checkDelete(f, rowId, draft);
			if (refused) return refused;
			try {
				return { op: 'delete' as const, deleted: await deleteEntry(app().userWork, c.caseId, def, rowId!), ...draft };
			} catch (e) {
				const x = failure(e, 'The deletion');
				return fail(x.status, { op: 'delete' as const, rowId, ...draft, message: deletionFailure(x.message) });
			}
		},
	};
}
