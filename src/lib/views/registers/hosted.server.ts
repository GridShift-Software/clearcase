// The seven registers on the hosted app (sprint ticket 17a): the local pages' data and actions over the user-work adapter.
// A page view is the one register read (`readViewWork`); a save is one `putRow`, which is one D1 batch with its audit, and
// carries the row's version, so a change made elsewhere is refused (409) instead of overwritten.
import { error, fail, type RequestEvent } from '@sveltejs/kit';
import type { DocumentAnchor } from '../../case-package/user-work.ts';
import type { Anchor, CaseId, RequestServices, ResultsVersion, Versioned, WorkRegisterRow } from '../../server/runtime/contracts.ts';
import { refuse } from '../../server/runtime/hosted/http.ts';
import { id, resultsVersion } from '../../server/runtime/ids.ts';
import { publishedVersion, type PublishedVersion } from '../hosted/payloads.server.ts';
import { guarded, hostedWork, type Work } from '../hosted/work-adapter.server.ts';
import { registerOf, type RegisterDef, type RegisterView } from './defs.ts';
import { byDate, type Entry } from './logic.ts';
import { checkDelete, checkSave, deletionFailure, GONE, readDelete, readSave, registerHead, shownRows, STALE, STALE_DELETE, type RowView } from './shown.ts';

type Params = Partial<Record<string, string>>;
type Event = { locals: RequestServices; params: Params };
type Fingerprints = Awaited<ReturnType<RequestServices['store']['fingerprints']>>;
export type HostedRow = RowView & { anchor: Anchor | null; createdAt: string };

const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const seqOf = (r: WorkRegisterRow): number => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : Number.MAX_SAFE_INTEGER);

/** The register's rows as the local page reads them: the def's fields as text, in the local order (seq, then creation). */
export function hostedRows(def: RegisterDef, rows: readonly Versioned<WorkRegisterRow>[]): HostedRow[] {
	return [...rows]
		.sort((a, b) => seqOf(a) - seqOf(b) || cmp(a.createdAt, b.createdAt) || cmp(a.rowId, b.rowId))
		.map((r) => ({ rowId: r.rowId, values: Object.fromEntries(def.fields.map((x) => [x.k, text(r.fields[x.k])])), version: r.version, intact: r.intact, anchor: r.anchor, createdAt: r.createdAt }));
}

const refFieldOf = (def: RegisterDef) => def.fields.find((x) => x.docRef)?.k;
/** A ref is a document of this version when the publication admits its shard: no storage read. */
const isDocument = (v: PublishedVersion, ref: string) => Object.hasOwn(v.publication.shards ?? {}, `doc/${ref}.json`);

/** Where each row's document ref points in this version: the ref itself, or, for a row anchored in an earlier version, the document its digest finds now. */
async function refTargets(locals: RequestServices, v: PublishedVersion, def: RegisterDef, rows: readonly HostedRow[]): Promise<Map<string, string | null>> {
	const field = refFieldOf(def), out = new Map<string, string | null>();
	if (!field) return out;
	let fps: Promise<Fingerprints> | undefined;
	for (const r of rows) {
		const ref = r.values[field]!;
		if (!ref) continue;
		let target: string | null = isDocument(v, ref) ? ref : null;
		const a = r.anchor;
		if (a && a.resultsVersion !== v.resultsVersion) {
			if (!a.sha256) target = null;
			else {
				const refs = (await (fps ??= locals.store.fingerprints({ caseId: v.caseId, resultsVersion: v.resultsVersion }).catch((e: unknown) => refuse(e)))).filter((f) => f.sha256 === a.sha256).map((f) => f.ref).sort();
				target = refs.length === 1 ? refs[0]! : null;
			}
		}
		out.set(r.rowId, target);
	}
	return out;
}

export function hostedRegisterLoad(view: RegisterView) {
	const def = registerOf(view);
	return async ({ locals, params }: Event) => {
		const v = await publishedVersion(locals, params);
		const work = await locals.userWork.readViewWork({ caseId: v.caseId, store: def.store }).catch((e: unknown) => refuse(e));
		const stored = hostedRows(def, work.rows);
		const targets = await refTargets(locals, v, def, stored);
		const at = locals.runtime.now();
		return {
			register: registerHead(view, def),
			rows: shownRows(def, view === 'deadlines_tab' ? byDate(stored) : stored, targets, at),
			exportRows: stored.map((r) => ({ rowId: r.rowId, values: r.values })),
			// The results package's export file name and calendar product id are not published as a shard: the neutral ones.
			exportName: { name: def.export.name, note: null },
			icsProductId: null,
			operationId: crypto.randomUUID(),
			base: v.base,
		};
	};
}

/**
 * The case and version a write names, from the URL alone. User work belongs to the case, not to a published version, and the
 * store authorizes the case itself, so a write does not wait on the publication lookup; an entry that names a document does
 * (see `anchorOf`).
 */
function writeScope(params: Params): { caseId: CaseId; resultsVersion: ResultsVersion } {
	try { return { caseId: id('case', params.caseId ?? ''), resultsVersion: resultsVersion(params.version ?? '') }; }
	catch { error(404, { message: 'Not found.', code: 'not-found' }); }
}

/** The anchor a saved entry carries: kept when its ref is unchanged and was anchored in this version, else a fresh one for a ref this version holds. */
async function anchorOf(def: RegisterDef, locals: RequestServices, params: Params, e: Entry, cur?: HostedRow): Promise<DocumentAnchor | null> {
	const k = refFieldOf(def);
	const ref = k ? e[k] : undefined;
	if (!k || !ref) return null;
	const v = await publishedVersion(locals, params);
	if (cur?.anchor && cur.values[k] === ref && cur.anchor.resultsVersion === v.resultsVersion) return cur.anchor as DocumentAnchor;
	// The adapter looks the document up and takes its digest from there.
	return isDocument(v, ref) ? { caseId: v.caseId, resultsVersion: v.resultsVersion, refAtCreation: ref, sha256: '' } : null;
}

const say = (what: string) => ({
	busy: `${what} was not saved: the store is busy or unavailable. Nothing was changed; try again.`,
	refused: `${what} was not saved: the store refused it. Nothing was changed; your input is kept.`,
	failed: `${what} was not saved: something went wrong. Nothing was changed; try again.`,
});

export function hostedRegisterActions(view: RegisterView) {
	const def = registerOf(view);
	return {
		save: async ({ locals, params, request }: RequestEvent) => {
			const s = readSave(def, await request.formData());
			const { values, rowId, version } = s;
			const refused = checkSave(def, s);
			if (refused) return refused;
			const v = writeScope(params);
			const operationId = s.operationId ?? crypto.randomUUID();
			const work = hostedWork(locals, v.caseId, v.resultsVersion, { operationId, version: version ?? '' });
			const result = await guarded('save', values, async (w: Work) => {
				// Only an entry that names a document and keeps its ref needs the row it replaces, for the anchor it already has.
				const cur = rowId && refFieldOf(def) ? hostedRows(def, await locals.userWork.readViewWork({ caseId: v.caseId, store: def.store }).then((r) => r.rows)).find((r) => r.rowId === rowId) : undefined;
				return w.putRow(v.caseId, def.store, rowId, values, await anchorOf(def, locals, params, values, cur));
			}, say(rowId ? 'The change' : 'The entry'), { rowId, version }, work);
			if (result.ok) return { saved: true, savedId: result.value };
			const { status, data } = result.failure;
			if (status !== 409) return result.failure;
			// the adapter's conflict (stale or gone) in the register page's words: gone is 404, as locally
			const gone = (data as { gone?: boolean }).gone === true;
			return s.refuse(gone ? 404 : 409, gone ? GONE : STALE);
		},
		delete: async ({ locals, params, request }: RequestEvent) => {
			const f = await request.formData();
			const { rowId, draft, version } = readDelete(def, f);
			const refused = checkDelete(f, rowId, draft);
			if (refused) return refused;
			const v = writeScope(params);
			const id = rowId!;
			// The page names the version of the row it shows, with JavaScript or without. A delete that names none is refused,
			// not run against the row as it is now: that would delete an edit the person never saw.
			if (!version) return fail(409, { op: 'delete' as const, rowId: id, ...draft, message: STALE_DELETE });
			const work = hostedWork(locals, v.caseId, v.resultsVersion, { operationId: crypto.randomUUID(), version });
			const result = await guarded('delete', null, (w: Work) => w.deleteRow(v.caseId, def.store, id), say('The deletion'), { rowId: id, ...draft }, work);
			if (result.ok) return { op: 'delete' as const, deleted: result.value, ...draft };
			const { status, data } = result.failure;
			if (status === 409) {
				// gone: the entry is already deleted, which is what was asked; stale: it changed since the page showed it
				if ((data as { gone?: boolean }).gone === true) return { op: 'delete' as const, deleted: false, ...draft };
				return fail(409, { op: 'delete' as const, rowId: id, ...draft, message: STALE_DELETE });
			}
			return fail(status, { op: 'delete' as const, rowId: id, ...draft, message: deletionFailure(String((data as { message?: unknown }).message)) });
		},
	};
}
