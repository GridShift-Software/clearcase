// Shared by the 17b entry tests (litigation, quantum, evidence, budget): the hosted routes' real actions and loads over the
// synthetic D1 user-work double. Every case, ref and value is invented. Not evidence of Cloudflare D1 or of a deployed save time.
import type * as C from '../../src/lib/server/runtime/contracts.ts';
import { fixture, CASE, RV1 } from '../hosted-foundation/user-work/helpers.ts';
export { CASE, RV1 };

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export const SEED_A = { datasetKey: 'lit-crossexam-seed', seedId: 'cx-1', seedSha256: 'a'.repeat(64), record: { witness: 'Imported witness', topic: 'Imported topic', put: 'Imported put', docs: '' } };
export const FILING_SEED = { datasetKey: 'filings', seedId: 'fr-1', seedSha256: 'b'.repeat(64), record: { filing: 'Imported filing', fdate: '2026-01-01', fparty: 'Imported party', response: '', rdate: '', ref: '', status: '' } };

/** The synthetic view shards the entry routes read: only what each loader and action takes from its shard. */
export const SHARDS: Record<string, unknown> = {
	'view/authorities_tab.json': { present: true, imported: [], known: [], exportName: { name: 'authorities.csv', note: null } },
	'view/heads_tab.json': { caption: null, exportName: { name: 'heads.txt', note: null }, known: [] },
	'view/crossexam_tab.json': { tip: null, knownSeedRefs: [], seeds: [SEED_A] },
	'view/enforcement_tab.json': {
		present: true, phases: ['Phase one'], content: { subtitle: null, why: null }, known: [],
		rows: [{ phase: 'Phase one', step: 'Synthetic step one', basis: 'Synthetic basis', status: 'To do', note: '', key: 'step-key-1', override: null }, { phase: 'Phase one', step: 'Synthetic step two', basis: '', status: 'To do', note: '', key: 'step-key-2', override: null }],
	},
	'view/payments_tab.json': { subtitle: null, claim: '', claimDate: '', recon: [], exportName: { name: 'payments.csv', note: null }, known: [] },
	'view/filings_tab.json': {
		groups: null, fileOf: [], seeds: [FILING_SEED], content: { subtitle: null, orientation: null, registerIntro: 'Synthetic intro.' },
		exportNames: { filings: { name: 'filings.csv', note: null }, register: { name: 'register.csv', note: null } },
	},
	'view/info_required_tab.json': { heading: 'Information required', rows: [{ key: 'info:one', item: 'Synthetic item one', owner: 'Client', status: 'Open', done: false }, { key: 'info:two', item: 'Synthetic item two', owner: 'Client', status: 'Open', done: false }] },
};

/** Request services over a user-work store, with the publication and the view shards of the synthetic version. */
export function localsOf(userWork: C.AsyncUserWork) {
	const admitted = Object.fromEntries(Object.entries(SHARDS).map(([name, v]) => [name, encode(v).byteLength]));
	return {
		userWork, runtime: { now: () => new Date('2026-11-01T10:00:00Z') },
		store: { publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: admitted }) },
		shards: { read: async (a: { name: string }) => new Response(encode(SHARDS[a.name])) },
	} as unknown as C.RequestServices;
}

export function world(subject = 'editor') {
	const f = fixture();
	if (subject !== 'editor') f.auth.grant(subject, CASE, 'viewer');
	const locals = localsOf(f.make(subject));
	const params = { caseId: CASE, version: RV1 };
	return { ...f, locals, params };
}
export type World = ReturnType<typeof world>;

type Route = { actions?: Record<string, unknown>; load?: unknown };
/** A POST to one of a hosted route's actions, with the form's fields. */
export function post(w: World, route: Route, action: string, fields: Record<string, string | string[]>, url = 'https://synthetic.invalid/') {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
	const event = { locals: w.locals, params: w.params, request: new Request(`${url}?/${action}`, { method: 'POST', body }), url: new URL(url) };
	return (route.actions![action] as (e: never) => Promise<any>)(event as never);
}
export const list = (w: World, route: Route, search = '') => (route.load as (e: never) => Promise<any>)({ locals: w.locals, params: w.params, url: new URL(`https://synthetic.invalid/${search}`) } as never);
const REDIRECTED = Symbol('redirect');
/** Like `post`, but a SvelteKit redirect (a saved filings row answers 303) is returned as `{ redirected: location }`. */
export async function postOrRedirect(w: World, route: Route, action: string, fields: Record<string, string>) {
	try { return await post(w, route, action, fields); }
	catch (e) { const r = e as { status?: number; location?: string }; if (r.status === 303) return { [REDIRECTED]: true, redirected: r.location }; throw e; }
}
