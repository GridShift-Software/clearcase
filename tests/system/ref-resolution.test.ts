// One ref rule on every view (GRS-51): a ref that only a document-row provider publishes (a rescan-added document,
// GRS-20) is a document of the version, so every view that links refs links it, and a ref nothing names links nowhere.
// Driven through a synthetic converted package, the real import, activation and store, and the route loaders.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { SynthRoots } from '../case-package/fixtures/synth';
import type { ChronologyListRow, DocumentStateRow } from '../../src/lib/local-case/model';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';

const NEW = 'RS-001', NONE = 'RS-404';
let root: string, lc: LocalCase, rv: string, caseId: string, undo: () => void;
const env = { ...process.env };

/** Cite the provider-only ref and a ref nothing names on each view that links refs. */
const cite = (r: SynthRoots) => {
	const D = r.DATA as Record<string, any>;
	const q = D.quantum, lit = D.lit;
	q.invoiceLedger.push({ ...q.invoiceLedger[0], ref: NEW, no: 'INV09001' }, { ...q.invoiceLedger[0], ref: NONE, no: 'INV09404' });
	lit.legality.docs.push({ ...lit.legality.docs[0], ref: NEW }, { ...lit.legality.docs[0], ref: NONE });
	lit.legality.intro = `See [[${NEW}]] and [[${NONE}]].`;
	lit.authorities[0].proposition = `Relies on [[${NEW}]] and [[${NONE}]].`;
	D.timeline.events.push({ ...D.timeline.events[0], ref: NEW }, { ...D.timeline.events[0], ref: NONE });
	q.amountDueSeries.push({ ...q.amountDueSeries[0], ref: NEW }, { ...q.amountDueSeries[0], ref: NONE });
	lit.prescription.push({ ...lit.prescription[0], ref: NEW }, { ...lit.prescription[0], ref: NONE });
	lit.prescSummary.note = lit.interestBasis.note = `See [[${NEW}]] and [[${NONE}]].`;
	lit.recon[0].supporting = [NEW, NONE];
	D.chronology[0].refs = [NEW, NONE];
	D.defenceMatrix[0].docs.push({ ...D.defenceMatrix[0].docs[0], ref: NEW }, { ...D.defenceMatrix[0].docs[0], ref: NONE });
	D.contradictions.categories[0].items[0].refs.push({ ...D.contradictions.categories[0].items[0].refs[0], ref: NEW }, { ...D.contradictions.categories[0].items[0].refs[0], ref: NONE });
};

const state: DocumentStateRow = { file: 'missing', preview: 'none', text: 'pending', mediaType: null, flags: ['rescan'], original: null, self: null };
const list: Omit<ChronologyListRow, 'ord'> = { ref: NEW, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Rescan', subject: 'new file', filename: 'new.pdf', sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'pending', parentRef: null, file: 'missing', preview: 'none', attachments: 0 };

beforeAll(async () => {
	root = await tempRoot('ref-resolution');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	const docs = await import('../../src/lib/local-case/documents.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'case'), { caseId: 'ref-resolution', edit: cite });
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
	undo = docs.registerDocumentRowProvider({ id: 'refrule', owner: 'GRS-51', revision: () => '1', rows: () => [{ ref: NEW, row: { ref: NEW }, list, state }] });
}, 120_000);
afterAll(async () => {
	undo?.();
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

type Loader = { load: (e: unknown) => Promise<unknown> };
const ROUTES: Record<string, () => Promise<unknown>> = {
	'quantum/invoice_ledger_tab': () => import('../../src/routes/v/[vid]/quantum/invoice_ledger_tab/+page.server'),
	'litigation/legality_tab': () => import('../../src/routes/v/[vid]/litigation/legality_tab/+page.server'),
	'litigation/authorities_tab': () => import('../../src/routes/v/[vid]/litigation/authorities_tab/+page.server'),
	'analysis/timeline': () => import('../../src/routes/v/[vid]/analysis/timeline/+page.server'),
	'analysis/vdm_matrix_tab': () => import('../../src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.server'),
	'analysis/contradictions_tab': () => import('../../src/routes/v/[vid]/analysis/contradictions_tab/+page.server'),
	'quantum/quantum_tab': () => import('../../src/routes/v/[vid]/quantum/quantum_tab/+page.server'),
	'quantum/payments_tab': () => import('../../src/routes/v/[vid]/quantum/payments_tab/+page.server'),
	'quantum/prescription_tab': () => import('../../src/routes/v/[vid]/quantum/prescription_tab/+page.server'),
	'quantum/interest_calc_tab': () => import('../../src/routes/v/[vid]/quantum/interest_calc_tab/+page.server'),
	'doc/[ref]': () => import('../../src/routes/v/[vid]/doc/[ref]/+page.server'),
	'litigation/heads_tab': () => import('../../src/routes/v/[vid]/litigation/heads_tab/+page.server'),
};
const route = (p: string) => ROUTES[p]!() as Promise<Loader>;
const load = async (p: string) => (await (await route(p)).load({ params: { vid: rv }, parent: async () => ({ version: { id: rv, caseId } }) })) as Record<string, unknown>;
const linked = (xs: unknown) => new Set(xs as string[]);

describe('a provider-only ref links on every view (one ref rule)', () => {
	it.each([
		['quantum/invoice_ledger_tab', 'known'],
		['litigation/legality_tab', 'exists'],
		['litigation/legality_tab', 'known'],
		['litigation/authorities_tab', 'known'],
		['analysis/timeline', 'known'],
		['analysis/vdm_matrix_tab', 'known'],
		['analysis/contradictions_tab', 'known'],
		['quantum/quantum_tab', 'known'],
		['quantum/payments_tab', 'known'],
		['quantum/prescription_tab', 'known'],
		['quantum/prescription_tab', 'noteKnown'],
		['quantum/interest_calc_tab', 'known'],
	])('%s › %s links the provider-only ref and not a ref nothing names', async (view, key) => {
		const refs = linked((await load(view))[key]);
		expect([...refs].filter((r) => r === NEW || r === NONE)).toEqual([NEW]);
	});
	it('litigation/heads_tab › evidence links the provider-only ref and not a ref nothing names', async () => {
		const { STORES, register } = await import('../../src/lib/views/litigation/register.server');
		await register(caseId, STORES.heads).add({ head: 'H', sub: 'S', auth: 'A', ref: `${NEW}, ${NONE}` }, { addId: null });
		const rows = (await load('litigation/heads_tab')).rows as { evidence: { text: string; ref: boolean }[] }[];
		expect(rows.at(-1)!.evidence).toEqual([{ text: NEW, ref: true }, { text: NONE, ref: false }]);
	});
	it('doc/[ref] › related links the provider-only ref and not a ref nothing names', async () => {
		const page = (await (await route('doc/[ref]')).load({ params: { vid: rv, ref: 'OD-001' }, url: new URL(`http://127.0.0.1/v/${rv}/doc/OD-001`), parent: async () => ({ version: { id: rv, caseId } }) })) as { related: { ref: string; exists: boolean }[] };
		expect(page.related.filter((x) => x.ref === NEW || x.ref === NONE)).toEqual([{ ref: NEW, exists: true }, { ref: NONE, exists: false }]);
	});
});
