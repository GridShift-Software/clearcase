import type { DropReason, DocumentRowsResult } from '../server/runtime/dto.ts';
export type { DropReason, DocumentRowsResult } from '../server/runtime/dto.ts';
import type { DocumentSource, DocumentRow, ProviderRow } from '../server/runtime/dto.ts';
export type { DocumentSource, DocumentRow, ProviderRow } from '../server/runtime/dto.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import type { CaseStore } from './store.server.ts';

export interface DocumentRowProvider {
	id: string;
	owner: string;
	rows(ctx: { caseId: string; resultsVersion: string }): readonly ProviderRow[];
	revision(ctx: { caseId: string; resultsVersion: string }): string;
}

const providers = new Map<string, DocumentRowProvider>();
const ID = /^[a-z][a-z0-9-]{0,31}$/;
export const REVISION = /^[A-Za-z0-9._:+\/=-]{1,128}$/;

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

const LIST_TEXT = ['date', 'docType', 'bundle', 'subject', 'filename', 'sender', 'to', 'excerpt', 'amount', 'url', 'textStatus', 'preview'] as const;
const LIST_NULLABLE = ['dateType', 'dateSource', 'parentRef'] as const;
const FILE = new Set(['present', 'missing', 'blocked']);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string';
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
const validOriginal = (o: Record<string, unknown>) => typeof o.path === 'string' && o.path.length > 0 && Number.isSafeInteger(o.size) && (o.size as number) >= 0 &&
	typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) && typeof o.mediaType === 'string';

function malformed(x: unknown): string | null {
	if (!isObject(x)) return 'not an object';
	if (typeof x.ref !== 'string' || !x.ref) return 'ref is not a non-empty string';
	// a lone surrogate survives the JSON copy but not encodeURIComponent, so a page linking to it would answer 500
	if (!x.ref.isWellFormed()) return 'ref is not well-formed Unicode';
	if (!isObject(x.row)) return 'row is not an object';
	const l = x.list, s = x.state;
	if (isObject(l) && l.ref !== x.ref) return 'the list entry names another ref';
	if (!isObject(l) || !LIST_TEXT.every((k) => isText(l[k])) || !LIST_NULLABLE.every((k) => isTextOrNull(l[k])) || !FILE.has(l.file as string) ||
		!Array.isArray(l.alsoIn) || !l.alsoIn.every(isText) || !Number.isFinite(l.attachments)) return 'list is not a chronology list entry';
	if (!isObject(s) || !FILE.has(s.file as string) || !isText(s.preview) || !isText(s.text) || !isTextOrNull(s.mediaType) || !Array.isArray(s.flags) ||
		!(s.original === null || isObject(s.original)) || !(s.self === null || isObject(s.self))) return 'state is not a document state';
	return null;
}

const message = (e: unknown) => {
	try { return String((e as Error)?.message ?? e).slice(0, 200); } catch { return 'a value that cannot be shown as text was thrown'; }
};

function refOf(x: unknown, i: number): string {
	try { const ref = (x as { ref?: unknown } | null)?.ref; if (typeof ref === 'string' && ref.isWellFormed()) return ref.slice(0, 200); } catch { /* reported by index */ }
	return `#${i}`;
}

function fromProviders(caseId: string, resultsVersion: string, taken: (ref: string) => boolean) {
	const rows: { source: DocumentSource; x: ProviderRow }[] = [];
	const dropped: DocumentRowsResult['dropped'] = [];
	const failed: DocumentRowsResult['failed'] = [];
	const revisions: string[] = [];
	const seen = new Set<string>();
	for (const p of providers.values()) {
		const source = `provider:${p.id}` as const;
		const mine: typeof rows = [], drops: typeof dropped = [], refs = new Set<string>();
		let rev: unknown;
		try {
			rev = p.revision({ caseId, resultsVersion });
			if (typeof rev !== 'string') throw new Error('revision() did not return a string');
			if (!REVISION.test(rev)) throw new Error('revision() did not return a safe ETag token');
			const xs: readonly unknown[] = p.rows({ caseId, resultsVersion });
			if (!Array.isArray(xs)) throw new Error('rows() did not return an array');
			for (let i = 0; i < xs.length; i++) {
				let x: ProviderRow;
				let item: unknown, copy: unknown;
				try {
					item = xs[i];
					if (!isObject(item)) throw new Error('not an object');
					copy = JSON.parse(JSON.stringify({ ref: item.ref, row: item.row, list: item.list, state: item.state }));
					const bad = malformed(copy);
					if (bad) throw new Error(bad);
					x = copy as ProviderRow;
				} catch (e) {
					const m = message(e);
					drops.push({ source, ref: refOf(copy ?? item, i), reason: m === 'the list entry names another ref' ? m : `malformed row: ${m}` });
					continue;
				}
				if (seen.has(x.ref) || refs.has(x.ref) || taken(x.ref)) { drops.push({ source, ref: x.ref, reason: 'the ref already names a document of this version' }); continue; }
				if (x.state.original && !validOriginal(x.state.original as unknown as Record<string, unknown>)) {
					x.state.original = null;
					drops.push({ source, ref: x.ref, reason: 'the original was left out: a present original needs a path, size, sha256 and media type' });
				}
				refs.add(x.ref);
				mine.push({ source, x });
			}
		} catch (e) {
			failed.push({ source, owner: p.owner, reason: message(e) });
			revisions.push(`${p.id}=!`);
			continue;
		}
		revisions.push(`${p.id}=${rev as string}`);
		for (const r of refs) seen.add(r);
		rows.push(...mine);
		dropped.push(...drops);
	}
	return { rows, dropped, failed, revisions };
}

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

export function resolveRefs(store: CaseStore, resultsVersion: string, refs: Iterable<string>): Set<string> {
	const want = [...new Set(refs)];
	const found = store.existingRefs(resultsVersion, want);
	if (providers.size === 0 || found.size === want.length) return found;
	const v = store.getVersion(resultsVersion);
	if (!v) return found;
	const open = new Set(want.filter((r) => !found.has(r)));
	for (const { x } of fromProviders(v.case_id, resultsVersion, (ref) => !!store.document(resultsVersion, ref)).rows) if (open.has(x.ref)) found.add(x.ref);
	return found;
}

export const anyDateBasis = (store: CaseStore, resultsVersion: string): boolean => { const j = store.chronologyJson(resultsVersion) ?? ''; return j.includes('"dateType":"') || j.includes('"dateSource":"'); };

export function documentCounts(store: CaseStore, resultsVersion: string): { total: number; imported: number; provided: number; failed: DocumentRowsResult['failed'] } {
	const v = store.getVersion(resultsVersion);
	if (!v) return { total: 0, imported: 0, provided: 0, failed: [] };
	const imported = store.documentCount(resultsVersion);
	if (providers.size === 0) return { total: imported, imported, provided: 0, failed: [] };
	const p = fromProviders(v.case_id, resultsVersion, (ref) => !!store.document(resultsVersion, ref));
	return { total: imported + p.rows.length, imported, provided: p.rows.length, failed: p.failed };
}

export function listJson(store: CaseStore, resultsVersion: string): { json: string; etag: string; failed: DocumentRowsResult['failed'] } | null {
	const v = store.getVersion(resultsVersion);
	if (!v) return null;
	if (providers.size === 0) return { json: store.chronologyJson(resultsVersion)!, etag: `"${v.read_model_sha256}"`, failed: [] };
	const { rows, failed, revisions } = collect(store, resultsVersion);
	const tag = failed.length ? `|failed=${failed.map((f) => f.source).join(',')}` : '';
	return { json: JSON.stringify(rows.map((r) => r.list)), etag: `"${v.read_model_sha256}|${revisions.join(';')}${tag}"`, failed };
}

export function activeDocumentRows(lc: { store: CaseStore; effectiveActive(caseId: string): string | undefined }, caseId: string): DocumentRowsResult & { resultsVersion: string | null } {
	const vid = lc.effectiveActive(caseId) ?? null;
	return vid ? { resultsVersion: vid, ...documentRows(lc.store, vid) } : { resultsVersion: null, rows: [], dropped: [], failed: [] };
}
