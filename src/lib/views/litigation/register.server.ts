import { citedRefs } from '$lib/components/cite';
import { actionCase, guarded } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { resolveRefs } from '$lib/local-case/documents.server';
import { registers, type VersionedRow, type Work } from '$lib/local-case/registers.server';
import { datasetOf, exportFileName, viewText } from '$lib/local-case/results.server';
import type { CaseStore } from '$lib/local-case/store.server';
import type { PureInput } from '$lib/views/payloads/views';
import { AUTH_FIELDS, AUTH_FILE, type AuthValues } from './authorities.ts';
import { CX_SEED } from './crossexam.ts';
import type { Ctx, Entries } from './answers.server.ts';

export * from './answers.server.ts';

export const register = (caseId: string, store: string, w: Work = app().userWork) => registers(w).open(caseId, store);

export const orderedRows = (caseId: string, store: string): VersionedRow[] => register(caseId, store).rows();

/** The local work store as the entry actions' port: `w` is the `Work` the actions run over, the app's own by default. */
export const localEntries = (caseId: string, resultsVersion: string, w: Work = app().userWork): Entries => ({
	add: (store, fields, addId) => registers(w).open(caseId, store).add(fields, { addId }),
	remove: (store, rowId, version) => registers(w).open(caseId, store).remove(rowId, version),
	removeSeed: (datasetKey, seedId, version) => registers(w).seeds(caseId, resultsVersion, datasetKey).remove(seedId, version),
});

export const localCtx = ({ params }: { params: Record<string, string | undefined> }): Ctx => {
	const { vid, caseId } = actionCase(params as { vid: string });
	return { caseId, entries: localEntries(caseId, vid), guard: guarded };
};

export const knownRefs = (resultsVersion: string, texts: Iterable<unknown>, store: CaseStore = app().store) =>
	[...resolveRefs(store, resultsVersion, citedRefs([...texts].filter((t): t is string => typeof t === 'string')))];

// Authorities and Cross-examination without their registers (ticket 04): what the operator machine builds into the shards.

export function authoritiesPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<unknown[]>(store, vid, 'lit-authorities');
	const imported = (Array.isArray(raw) ? raw : []).map((r) => {
		const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		return Object.fromEntries(AUTH_FIELDS.map((k) => [k, o[k] === null || o[k] === undefined ? '' : String(o[k])])) as AuthValues;
	});
	return { present: Array.isArray(raw), imported, known: knownRefs(vid, imported.map((r) => r.proposition), store), exportName: exportFileName(vc, 'authorities_tab', AUTH_FILE) };
}

export function crossexamPure({ store, vid, vc }: PureInput) {
	const puts = store.seeds(vid).filter((s) => s.dataset_key === CX_SEED).map((s) => (JSON.parse(s.record_json) as Record<string, unknown>).put);
	// the cited refs of every imported topic; the page links those of the topics it still shows as imported
	return { tip: viewText(vc, 'crossexam_tab', 'tip'), knownSeedRefs: knownRefs(vid, puts, store) };
}
