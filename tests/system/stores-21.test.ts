// GRS-56 item 2: every one of the 21 live v5 user-work stores (V5_STORES, GRS-20's coverage list) round-trips through the
// real createBackup and restoreBackup. Each store is written through its owner's storage, backed up, then read back after a
// restore into a fresh profile and after a restore over changed work; the value read must equal the value written.
// Synthetic case; no mocks. The earlier scratch attempt (reports/CC-10/report.md, line 23) reached 19 of 21.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase, putOriginal } from '../e2e/pilot/lib/fixtures.ts';
import { INFO_STORE, itemKeys, saveDone } from '../../src/lib/analysis/info-required.server.ts';
import { rescan, rescanRows } from '../../src/lib/local-case/rescan/rescan.server.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';
import { createBackup, restoreBackup } from '../../src/lib/user-work/backup/backup.server.ts';
import { V5_STORES } from '../../src/lib/user-work/backup/v5-keys.ts';
import { REGISTERS } from '../../src/lib/views/registers/defs.ts';
import { REGISTER_STORE as FILINGS } from '../../src/lib/views/evidence/filings.ts';
import { PAYMENTS_STORE } from '../../src/lib/views/quantum/payments.ts';

const g = globalThis as { __clearcase?: unknown };
const CASE = 'stores-21';
let root: string;
const opened: LocalCase[] = [];
afterAll(async () => { for (const lc of opened) try { lc.shutdown(); } catch { /* closed */ } if (root) await cleanup(root); });

async function profile(name: string, dir: string) {
	const lc = service(path.join(root, name));
	opened.push(lc);
	await lc.startup();
	const built = await buildCase(dir, { caseId: CASE });
	const i = await lc.importPackage(built.caseDir, built.pkgDir);
	expect(await lc.activate(built.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
	return { lc, rv: built.resultsVersion };
}
/** Point GRS-19's store module (it reads app()) at `lc`, with a fresh module graph. */
async function bundlesStore(lc: LocalCase) {
	g.__clearcase = { app: lc, originals: null, id: 'stores-21', startedAt: '', build: null };
	vi.resetModules();
	return import('../../src/lib/views/bundles/store.server.ts');
}

type Bundles = Awaited<ReturnType<typeof bundlesStore>>;
interface Ctx { lc: LocalCase; rv: string; b: Bundles }
interface Store { key: string; write(c: Ctx): Promise<void>; read(c: Ctx): Promise<unknown> | unknown }

/** A register store's rows, as stored: ids, fields, anchor and timestamps. */
const rows = (store: string): Pick<Store, 'read'>['read'] => ({ lc }) => lc.userWork.listRows(CASE, store);
const putRow = (store: string, fields: Record<string, string | number | boolean | null>) => async ({ lc }: Ctx) => { await lc.userWork.putRow(CASE, store, null, fields); };
const register = (key: string, store: string, fields: Record<string, string | number | boolean | null>): Store => ({ key, write: putRow(store, { ...fields, seq: 1 }), read: rows(store) });

const ITEMS = [{ item: 'Provide the signed lease', owner: 'Client', status: 'open' }, { item: 'Confirm the service address', owner: 'Attorney', status: 'open' }];
const OUTPUT = { name: 'Hearing bundle', pages: 6, indexPages: 1, filePages: 7, note: 'saved', rows: [{ n: 1, key: '', desc: 'ALPHA', pages: 6, from: 1, to: 6, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 6 }] }] };

const STORES: Store[] = [
	register('ess_dcs_annotations_v1', REGISTERS.annotations_tab.store, { ref: 'OD-001', date: '2001-03-01', note: 'annotation' }),
	register('ess_dcs_authorities_v1', 'authorities', { citation: 'S v Synthetic 2001 (1) SA 1', note: 'authority' }),
	register('ess_dcs_crossexam_v1', 'crossexam', { witness: 'W. Synthetic', topic: 'topic', note: 'cross' }),
	register('ess_dcs_deadlines_v1', REGISTERS.deadlines_tab.store, { title: 'File reply', date: '2001-03-01', cat: 'Filing' }),
	register('ess_dcs_disbursements_v1', REGISTERS.disbursements_tab.store, { date: '2001-03-02', desc: 'Sheriff fee', payee: 'Sheriff', amount: '120.50' }),
	register('ess_dcs_enf_status_v1', 'enforcement-status', { step: 'demand', status: 'done' }),
	register('ess_dcs_filings_v1', FILINGS, { filing: 'Notice of motion', fdate: '2001-03-03', fparty: 'Applicant', status: 'filed' }),
	register('ess_dcs_heads_v1', 'heads', { heading: 'Heads of argument', note: 'heads' }),
	register('ess_dcs_payments_v1', PAYMENTS_STORE, { date: '2001-03-04', amount: '1000.00', method: 'EFT', note: 'payment' }),
	register('ess_dcs_popia_v1', REGISTERS.popia_tab.store, { activity: 'Intake', category: 'Contact', lawful: 'Consent', retention: '5 years' }),
	register('ess_dcs_privilege_v1', REGISTERS.privilege_tab.store, { ref: 'OD-002', date: '2001-03-05', desc: 'Advice letter', basis: 'Legal advice' }),
	register('ess_dcs_timesheet_v1', REGISTERS.timesheet_tab.store, { date: '2001-03-06', fee_earner: 'AB', activity: 'Drafting', hours: 1.5, billed: 'no' }),
	register('ess_dcs_transcripts_v1', REGISTERS.transcriptions_tab.store, { title: 'Hearing day 1', date: '2001-03-07', source: 'recording', body: 'transcript text' }),
	{
		key: 'ess_dcs_info_done_v1', // GRS-15: a flag per checklist item, keyed by a digest of the item text
		write: async ({ lc, rv }) => { expect(await saveDone(lc.userWork, CASE, rv, ITEMS, itemKeys(ITEMS)[1]!, true)).toBe(true); },
		read: rows(INFO_STORE),
	},
	{
		key: 'ess_dcs_custom_bundles_v1', // GRS-19: the builder's saved bundles, a defined table
		write: async ({ b }) => { await b.saveCustom(CASE, 'output-1', OUTPUT, []); },
		read: ({ b }) => b.readCustom(CASE),
	},
	{
		key: 'ess_dcs_bundle_header_v2',
		write: async ({ b }) => { await b.putSingle(CASE, b.HEADER_STORE, { title: 'Index to the bundle', court: 'High Court' }); },
		read: ({ b }) => b.singleRow(CASE, b.HEADER_STORE),
	},
	{
		key: 'ess_dcs_caselines_docs_v1',
		write: async ({ b }) => { await b.addLink(CASE, 'DISCOVERY A/OD-001.pdf'); },
		read: ({ lc, b }) => lc.userWork.listRows(CASE, b.LINKS_STORE),
	},
	{
		key: 'ess_dcs_schedule_mode_v1',
		write: async ({ b }) => { await b.putSingle(CASE, b.MODE_STORE, { mode: 'supplementary' }); },
		read: ({ b }) => b.readMode(CASE),
	},
	{
		key: 'ess_dcs_schedule_sel_v1',
		write: async ({ b }) => { await b.writeMarks(CASE, [{ locator: 'DISCOVERY A/OD-001.pdf' }, { locator: 'DISCOVERY A/OD-002.pdf' }], { selected: true }); },
		read: async ({ b }) => (await b.readMarks(CASE)).map((m) => [m.locator, m.selected]),
	},
	{
		key: 'ess_dcs_schedule_co_v1',
		write: async ({ b }) => { await b.writeMarks(CASE, [{ locator: 'DISCOVERY A/OD-002.pdf' }], { co: 'O' }); },
		read: async ({ b }) => (await b.readMarks(CASE)).map((m) => [m.locator, m.co]),
	},
	{
		key: 'ess_dcs_rescan_v1', // GRS-20: the files a rescan found, written by a real scan of an added original
		write: async ({ lc, rv }) => { await rescan(lc, rv, 'quick'); },
		read: ({ lc, rv }) => rescanRows(lc, CASE, rv),
	},
];

let a: Ctx;
beforeAll(async () => {
	root = await tempRoot('stores-21');
	const { lc, rv } = await profile('a', path.join(root, 'c1'));
	a = { lc, rv, b: await bundlesStore(lc) };
	await putOriginal(lc.store.getVersion(rv)!.case_root, 'DISCOVERY A/OD-005 Added.pdf', new TextEncoder().encode('%PDF-1.4 x'));
	for (const s of STORES) await s.write(a);
}, 120_000);

const readAll = async (c: Ctx) => Object.fromEntries(await Promise.all(STORES.map(async (s) => [s.key, await s.read(c)])));

describe('the 21 v5 stores round-trip through backup and restore', () => {
	it('the test covers exactly the stores of the coverage list', () => {
		expect(STORES.map((s) => s.key).sort()).toEqual(V5_STORES.map((s) => s.key).sort());
		expect(STORES).toHaveLength(21);
	});

	it('every store holds a written value before the backup', async () => {
		const written = await readAll(a);
		for (const s of STORES) {
			const v = written[s.key];
			expect(Array.isArray(v) ? v.length : v, s.key).toBeTruthy();
		}
		expect(written.ess_dcs_schedule_mode_v1).toBe('supplementary');
	});

	it('restored into a fresh profile, every store reads back identically', async () => {
		const before = await readAll(a);
		const text = JSON.stringify(createBackup(a.lc, a.rv));
		const { lc, rv } = await profile('fresh', path.join(root, 'c2'));
		const b = await bundlesStore(lc);
		const out = await restoreBackup(lc, text, { caseId: CASE, resultsVersion: rv });
		expect(out.kind).toBe('restored');
		const after = await readAll({ lc, rv, b });
		for (const s of STORES) expect(after[s.key], s.key).toEqual(before[s.key]);
		// back to the first profile for the next test
		a = { ...a, b: await bundlesStore(a.lc) };
	});

	it('restored over changed work, every store reads back identically', async () => {
		const before = await readAll(a);
		const text = JSON.stringify(createBackup(a.lc, a.rv));
		// change every store: one more write of each kind after the backup
		await a.lc.userWork.addNote(CASE, a.rv, 'OD-003', 'added after the backup');
		for (const st of new Set(a.lc.userWork.registerStores(CASE))) await a.lc.userWork.putRow(CASE, st, null, { changed: 'after the backup' });
		await a.b.saveCustom(CASE, 'output-2', { ...OUTPUT, name: 'Added after' }, []);
		await a.b.writeMarks(CASE, [{ locator: 'DISCOVERY A/OD-009.pdf' }], { selected: true });
		await a.b.putSingle(CASE, a.b.MODE_STORE, { mode: 'discovery' });
		expect(await readAll(a)).not.toEqual(before);
		const out = await restoreBackup(a.lc, text, { caseId: CASE, resultsVersion: a.rv });
		expect(out.kind).toBe('restored');
		const after = await readAll(a);
		for (const s of STORES) expect(after[s.key], s.key).toEqual(before[s.key]);
	});

	it('the backup file itself holds the stores as rows of registered tables, and the coverage list names the owner of info_done as GRS-15', () => {
		const file = createBackup(a.lc, a.rv);
		const names = new Set(file.userWork.tables.filter((t) => t.rows.length).map((t) => t.name));
		for (const t of ['register_row', 'bundles_custom', 'bundles_schedule_mark', 'rescan_file']) expect(names.has(t), t).toBe(true);
		expect(V5_STORES.find((s) => s.key === 'ess_dcs_info_done_v1')?.owner).toBe('GRS-15');
	});
});
