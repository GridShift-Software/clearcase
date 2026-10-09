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

export interface DocumentRowsResult {
	rows: readonly DocumentRow[];
	/** provider rows left out: a ref already taken, or a malformed row (not the ProviderRow shape, or not plain data) */
	dropped: { source: DocumentSource; ref: string; reason: string }[];
	/** providers whose rows() or revision() threw (or returned the wrong type): their rows are left out and the
	 *  readers show a degraded state */
	failed: { source: DocumentSource; owner: string; reason: string }[];
}

const LIST_TEXT = ['date', 'docType', 'bundle', 'subject', 'filename', 'sender', 'to', 'excerpt', 'amount', 'url', 'textStatus', 'preview'] as const;
const LIST_NULLABLE = ['dateType', 'dateSource', 'parentRef'] as const;
const FILE = new Set(['present', 'missing', 'blocked']);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string';
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';

/** Why a provider row cannot be shown (null when it is a well-formed ProviderRow). */
function malformed(x: unknown): string | null {
	if (!isObject(x)) return 'not an object';
	if (typeof x.ref !== 'string' || !x.ref) return 'ref is not a non-empty string';
	if (!isObject(x.row)) return 'row is not an object';
	const l = x.list, s = x.state;
	if (!isObject(l) || !LIST_TEXT.every((k) => isText(l[k])) || !LIST_NULLABLE.every((k) => isTextOrNull(l[k])) || !FILE.has(l.file as string) ||
		!Array.isArray(l.alsoIn) || !l.alsoIn.every(isText) || !Number.isFinite(l.attachments)) return 'list is not a chronology list entry';
	if (!isObject(s) || !FILE.has(s.file as string) || !isText(s.preview) || !isText(s.text) || !isTextOrNull(s.mediaType) || !Array.isArray(s.flags) ||
		!(s.original === null || isObject(s.original)) || !(s.self === null || isObject(s.self))) return 'state is not a document state';
	return null;
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** Provider rows in registration order, minus refs already taken (imported refs first) and malformed rows; a provider
 *  whose rows() or revision() throws is isolated. Rows are copied as JSON, so readers get plain data only. */
function fromProviders(caseId: string, resultsVersion: string, taken: (ref: string) => boolean) {
	const rows: { source: DocumentSource; x: ProviderRow }[] = [];
	const dropped: DocumentRowsResult['dropped'] = [];
	const failed: DocumentRowsResult['failed'] = [];
	const revisions: string[] = [];
	const seen = new Set<string>();
	for (const p of providers.values()) {
		const source = `provider:${p.id}` as const;
		let xs: readonly unknown[];
		try {
			const rev = p.revision({ caseId, resultsVersion });
			if (typeof rev !== 'string') throw new Error('revision() did not return a string');
			revisions.push(`${p.id}=${rev}`);
			xs = p.rows({ caseId, resultsVersion });
			if (!Array.isArray(xs)) throw new Error('rows() did not return an array');
		} catch (e) {
			failed.push({ source, owner: p.owner, reason: message(e) });
			revisions.push(`${p.id}=!`);
			continue;
		}
		for (let i = 0; i < xs.length; i++) {
			let x: ProviderRow;
			try {
				const bad = malformed(xs[i]);
				if (bad) throw new Error(bad);
				const { ref, row, list, state } = xs[i] as ProviderRow;
				x = JSON.parse(JSON.stringify({ ref, row, list, state })) as ProviderRow;
			} catch (e) {
				const ref = (xs[i] as { ref?: unknown } | null)?.ref;
				dropped.push({ source, ref: typeof ref === 'string' ? ref.slice(0, 200) : `#${i}`, reason: `malformed row: ${message(e)}` });
				continue;
			}
			if (seen.has(x.ref) || taken(x.ref)) { dropped.push({ source, ref: x.ref, reason: 'the ref already names a document of this version' }); continue; }
			seen.add(x.ref);
			rows.push({ source, x });
		}
	}
	return { rows, dropped, failed, revisions };
}

/** Every document row of a stored version: the imported register in source order, then provider rows. */
export function documentRows(store: CaseStore, resultsVersion: string): DocumentRowsResult {
	const { rows, dropped, failed } = collect(store, resultsVersion);
	return { rows, dropped, failed };
}
function collect(store: CaseStore, resultsVersion: string): DocumentRowsResult & { revisions: string[] } {
	const v = store.getVersion(resultsVersion);
	if (!v) return { rows: [], dropped: [], failed: [], revisions: [] };
	const list = JSON.parse(store.chronologyJson(resultsVersion) ?? '[]') as ChronologyListRow[];
	const byRef = new Map(store.projectionRows(resultsVersion).documents.map((d) => [d.ref, d]));
	const rows: DocumentRow[] = list.map((l) => {
		const d = byRef.get(l.ref)!;
		return freeze({ ref: l.ref, ord: l.ord, source: 'results' as const, row: JSON.parse(d.row_json), list: l, state: JSON.parse(d.state_json) });
	});
	const p = fromProviders(v.case_id, resultsVersion, (ref) => byRef.has(ref));
	let ord = rows.length;
	for (const { source, x } of p.rows) { rows.push(freeze({ ref: x.ref, ord, source, row: { ...x.row }, list: { ...x.list, ord }, state: x.state })); ord++; }
	return { rows, dropped: p.dropped, failed: p.failed, revisions: p.revisions };
}

/** One document row by ref through the same contract (an imported ref always wins), or null. */
export function documentRow(store: CaseStore, resultsVersion: string, ref: string): DocumentRow | null {
	if (!store.getVersion(resultsVersion)) return null;
	const d = store.document(resultsVersion, ref);
	if (d) {
		const list = (JSON.parse(store.chronologyJson(resultsVersion) ?? '[]') as ChronologyListRow[]).find((l) => l.ref === ref)!;
		return freeze({ ref, ord: d.ord, source: 'results', row: JSON.parse(d.row_json), list, state: JSON.parse(d.state_json) });
	}
	if (providers.size === 0) return null;
	return documentRows(store, resultsVersion).rows.find((r) => r.ref === ref) ?? null;
}

/** How many document rows documentRows() returns, without parsing the register: imported plus accepted provider rows. */
export function documentCounts(store: CaseStore, resultsVersion: string): { total: number; imported: number; provided: number; failed: DocumentRowsResult['failed'] } {
	const v = store.getVersion(resultsVersion);
	if (!v) return { total: 0, imported: 0, provided: 0, failed: [] };
	const imported = store.documentCount(resultsVersion);
	if (providers.size === 0) return { total: imported, imported, provided: 0, failed: [] };
	const p = fromProviders(v.case_id, resultsVersion, (ref) => !!store.document(resultsVersion, ref));
	return { total: imported + p.rows.length, imported, provided: p.rows.length, failed: p.failed };
}

/** The chronology list JSON and its ETag: the stored list as-is when no provider publishes rows. `failed` names the
 *  providers left out because rows() or revision() threw (the list is then degraded, and its ETag says so). */
export function listJson(store: CaseStore, resultsVersion: string): { json: string; etag: string; failed: DocumentRowsResult['failed'] } | null {
	const v = store.getVersion(resultsVersion);
	if (!v) return null;
	if (providers.size === 0) return { json: store.chronologyJson(resultsVersion)!, etag: `"${v.read_model_sha256}"`, failed: [] };
	const { rows, failed, revisions } = collect(store, resultsVersion);
	const tag = failed.length ? `|failed=${failed.map((f) => f.source).join(',')}` : '';
	return { json: JSON.stringify(rows.map((r) => r.list)), etag: `"${v.read_model_sha256}|${revisions.join(';')}${tag}"`, failed };
}

/** The active version's document rows for a case (what v5's allRows() returned), or none when nothing is active. */
export function activeDocumentRows(lc: { store: CaseStore; effectiveActive(caseId: string): string | undefined }, caseId: string): DocumentRowsResult & { resultsVersion: string | null } {
	const vid = lc.effectiveActive(caseId) ?? null;
	return vid ? { resultsVersion: vid, ...documentRows(lc.store, vid) } : { resultsVersion: null, rows: [], dropped: [], failed: [] };
}
