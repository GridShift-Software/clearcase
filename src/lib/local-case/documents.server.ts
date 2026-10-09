// The document-row read contract (the equivalent of v5's allRows()): every document row of a results version, the
// imported register first in source order, then rows published by registered providers. GRS-20's rescan will
// publish rescanned rows as a provider; readers (chronology, documents, search, exports) call documentRows() or
// listJson() and never change when a provider appears.
//  * Imported rows are the raw chronology rows exactly as stored (canonical JSON), with the projected list entry and
//    document state. They are immutable results.
//  * Provider rows are not results: each carries its provider id as `source`, and its own list entry and state.
//    A provider ref that collides with an imported ref is dropped and reported, never shadowing the register.
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import type { CaseStore } from './store.server.ts';

export type DocumentSource = 'results' | `provider:${string}`;
export interface DocumentRow {
	ref: string;
	/** imported rows: position in the source register; provider rows continue after the last imported row */
	ord: number;
	source: DocumentSource;
	/** the raw source row, unchanged (v5 chronology shape), frozen */
	row: Readonly<Record<string, unknown>>;
	/** the display projection used by lists */
	list: Readonly<ChronologyListRow>;
	state: Readonly<DocumentStateRow>;
}
export interface ProviderRow { ref: string; row: Record<string, unknown>; list: Omit<ChronologyListRow, 'ord'>; state: DocumentStateRow }
export interface DocumentRowProvider {
	/** stable id, e.g. 'rescan' */
	id: string;
	/** owning Linear issue, e.g. 'GRS-20' */
	owner: string;
	/** rows for one version of one case, in the order to show them */
	rows(ctx: { caseId: string; resultsVersion: string }): readonly ProviderRow[];
	/** changes whenever rows() would return something else (part of the list ETag) */
	revision(ctx: { caseId: string; resultsVersion: string }): string;
}

const providers = new Map<string, DocumentRowProvider>();
const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Register a provider (once per id). Returns an unregister function (tests, shutdown). */
export function registerDocumentRowProvider(p: DocumentRowProvider): () => void {
	if (!ID.test(p.id)) throw new Error(`invalid document-row provider id ${p.id}`);
	if (providers.has(p.id)) throw new Error(`document-row provider ${p.id} is already registered`);
	providers.set(p.id, p);
	return () => { if (providers.get(p.id) === p) providers.delete(p.id); };
}
export const documentRowProviders = (): { id: string; owner: string }[] => [...providers.values()].map((p) => ({ id: p.id, owner: p.owner }));

const freeze = <T>(v: T): T => {
	if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]); }
	return v;
};

export interface DocumentRowsResult { rows: readonly DocumentRow[]; dropped: { source: DocumentSource; ref: string; reason: string }[] }

/** Every document row of a stored version: the imported register in source order, then provider rows. */
export function documentRows(store: CaseStore, resultsVersion: string): DocumentRowsResult {
	const v = store.getVersion(resultsVersion);
	if (!v) return { rows: [], dropped: [] };
	const list = JSON.parse(store.chronologyJson(resultsVersion) ?? '[]') as ChronologyListRow[];
	const byRef = new Map(store.projectionRows(resultsVersion).documents.map((d) => [d.ref, d]));
	const rows: DocumentRow[] = list.map((l) => {
		const d = byRef.get(l.ref)!;
		return freeze({ ref: l.ref, ord: l.ord, source: 'results' as const, row: JSON.parse(d.row_json), list: l, state: JSON.parse(d.state_json) });
	});
	const dropped: DocumentRowsResult['dropped'] = [];
	const seen = new Set(rows.map((r) => r.ref));
	let ord = rows.length;
	for (const p of providers.values()) {
		const source = `provider:${p.id}` as const;
		for (const x of p.rows({ caseId: v.case_id, resultsVersion })) {
			if (seen.has(x.ref)) { dropped.push({ source, ref: x.ref, reason: 'the ref already names a document of this version' }); continue; }
			seen.add(x.ref);
			rows.push(freeze({ ref: x.ref, ord, source, row: { ...x.row }, list: { ...x.list, ord }, state: x.state }));
			ord++;
		}
	}
	return { rows, dropped };
}

/** The chronology list JSON and its ETag: the stored list as-is when no provider publishes rows. */
export function listJson(store: CaseStore, resultsVersion: string): { json: string; etag: string } | null {
	const v = store.getVersion(resultsVersion);
	if (!v) return null;
	if (providers.size === 0) return { json: store.chronologyJson(resultsVersion)!, etag: `"${v.read_model_sha256}"` };
	const revs = [...providers.values()].map((p) => `${p.id}=${p.revision({ caseId: v.case_id, resultsVersion })}`).join(';');
	return { json: JSON.stringify(documentRows(store, resultsVersion).rows.map((r) => r.list)), etag: `"${v.read_model_sha256}|${revs}"` };
}

/** The active version's document rows for a case (what v5's allRows() returned), or none when nothing is active. */
export function activeDocumentRows(lc: { store: CaseStore; effectiveActive(caseId: string): string | undefined }, caseId: string): DocumentRowsResult & { resultsVersion: string | null } {
	const vid = lc.effectiveActive(caseId) ?? null;
	return vid ? { resultsVersion: vid, ...documentRows(lc.store, vid) } : { resultsVersion: null, rows: [], dropped: [] };
}
