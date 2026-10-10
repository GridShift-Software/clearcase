// The register page's real load and save/delete actions on a synthetic case (GRS-17, CC-07 r2), driven as the form
// and two tabs drive them: a success never returns a row id (D1), an edit never re-creates a deleted row (D6), a stale
// edit is refused with 409 and its input kept (D7), the amount grammar refuses with 400 and keeps the text (D10), an
// emptied edit says why (D13), an altered row is marked (D15), another case's row id is never written (D18).
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';

let root: string, lc: LocalCase, rv: string, caseId: string;
let P: typeof import('../../src/lib/views/registers/page.server');
const env = { ...process.env };
beforeAll(async () => {
	root = await tempRoot('registers-actions');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	P = await import('../../src/lib/views/registers/page.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'c'));
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
}, 120_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

type View = Parameters<typeof P.registerActions>[0];
/** One POST to a register action, as the form submits it (multipart). */
async function post(view: View, action: 'save' | 'delete', fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	const request = new Request(`http://127.0.0.1/v/${rv}/registers/${view}?/${action}`, { method: 'POST', body: fd });
	const r = (await (P.registerActions(view)[action] as (e: unknown) => Promise<unknown>)({ params: { vid: rv }, request })) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
	return r && typeof r.status === 'number' && 'data' in r ? { failed: r.status, ...r.data } : { ok: true, ...r };
}
const load = async (view: View) => (await P.registerLoad(view)({ parent: async () => ({ version: { id: rv, caseId } }) })) as { rows: { rowId: string; values: Record<string, string>; version: string; intact: boolean; cells: { text?: string; flag?: string }[] }[] };
const clear = async (view: View) => { for (const r of (await load(view)).rows) await post(view, 'delete', { rowId: r.rowId }); };
const hold = () => { const l = new DatabaseSync(lc.storage.workFile); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); return () => { l.exec('ROLLBACK'); l.close(); }; };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const D = 'disbursements_tab' as const;
const v0 = { date: '2026-10-01', desc: 'Synthetic original', payee: 'p', amount: '10' };

describe('register actions', () => {
	it('return no row id on a successful Add, so a page re-rendered from it never edits the new row (D1)', async () => {
		await clear(D);
		const a = await post(D, 'save', { ...v0, desc: 'Synthetic first' });
		const b = await post(D, 'save', { ...v0, desc: 'Synthetic second' });
		expect(a).toMatchObject({ ok: true, saved: true });
		expect(a).not.toHaveProperty('rowId');
		expect(b).not.toHaveProperty('rowId');
		expect((await load(D)).rows.map((r) => r.values.desc)).toEqual(['Synthetic first', 'Synthetic second']);
	});

	it('refuse an edit of a row deleted elsewhere with 404, keeping the input, and never re-create it (D6)', async () => {
		await clear(D);
		await post(D, 'save', v0);
		const [r] = (await load(D)).rows;
		const release = hold();
		const del = post(D, 'delete', { rowId: r!.rowId });
		await pause(50);
		const edit = post(D, 'save', { rowId: r!.rowId, version: r!.version, ...v0, desc: 'Synthetic tab A' });
		await pause(50);
		release();
		expect(await del).toMatchObject({ ok: true, deleted: true });
		expect(await edit).toMatchObject({ failed: 404, op: 'save', rowId: r!.rowId, values: { desc: 'Synthetic tab A' }, message: expect.stringMatching(/deleted elsewhere/) });
		expect((await load(D)).rows).toEqual([]);
		// the edit first, then the delete: the edit is saved, then the row is deleted; it does not come back
		await post(D, 'save', v0);
		const [s] = (await load(D)).rows;
		const release2 = hold();
		const edit2 = post(D, 'save', { rowId: s!.rowId, version: s!.version, ...v0, desc: 'Synthetic tab A' });
		await pause(50);
		const del2 = post(D, 'delete', { rowId: s!.rowId });
		await pause(50);
		release2();
		expect([await edit2, await del2]).toMatchObject([{ ok: true, saved: true }, { ok: true, deleted: true }]);
		expect((await load(D)).rows).toEqual([]);
	}, 60_000);

	it('refuse the later of two edits made from the same loaded row with 409, keeping its input (D7)', async () => {
		await clear(D);
		await post(D, 'save', v0);
		const [r] = (await load(D)).rows;
		const a = await post(D, 'save', { rowId: r!.rowId, version: r!.version, ...v0, desc: 'Synthetic tab A change' });
		const b = await post(D, 'save', { rowId: r!.rowId, version: r!.version, ...v0, amount: '20' });
		expect(a).toMatchObject({ ok: true, saved: true });
		expect(b).toMatchObject({ failed: 409, op: 'save', values: { amount: '20' }, message: expect.stringMatching(/changed elsewhere/), retry: false });
		expect((await load(D)).rows[0]!.values).toMatchObject({ desc: 'Synthetic tab A change', amount: '10' });
		// an edit that names no version cannot be checked and is refused too
		expect(await post(D, 'save', { rowId: r!.rowId, ...v0 })).toMatchObject({ failed: 409 });
	});

	it('refuse an amount, rate or hours the grammar does not accept with 400, keeping the typed text (D10)', async () => {
		await clear(D);
		for (const amount of ['1 500,50', '−150.00', '1e3', 'Synthetic entry 1']) {
			expect(await post(D, 'save', { ...v0, amount })).toMatchObject({ failed: 400, op: 'save', values: { amount }, message: expect.stringMatching(/^Amount \(R\) /) });
		}
		const T = 'timesheet_tab' as const;
		await clear(T);
		const t = { date: '2026-10-01', fee_earner: 'Synthetic', activity: 'Synthetic', hours: '2,5', rate: '1200', billed: 'no' };
		expect(await post(T, 'save', t)).toMatchObject({ failed: 400, values: { hours: '2,5' }, message: expect.stringMatching(/^Hours uses a decimal comma/) });
		expect(await post(T, 'save', { ...t, hours: '1.5', rate: '-1' })).toMatchObject({ failed: 400, message: expect.stringMatching(/^Rate\/h \(R\) cannot be negative/) });
		expect(await post(T, 'save', { ...t, hours: '1e11', rate: '1e10' })).toMatchObject({ failed: 400 });
		expect((await load(D)).rows).toEqual([]);
		expect((await load(T)).rows).toEqual([]);
		expect(await post(D, 'save', { ...v0, amount: '-R 150.00' })).toMatchObject({ ok: true, saved: true });
		expect((await load(D)).rows[0]!.cells[3]).toEqual({ kind: 'text', text: '-R 150.00' });
	});

	it('show a stored amount that does not parse as typed, flagged as not counted (D10)', async () => {
		await clear('timesheet_tab');
		await lc.userWork.putRow(caseId, 'timesheet', null, { date: '', fee_earner: '', activity: 'Synthetic restored', hours: '2,5', rate: '100', billed: '', seq: 1 });
		const [r] = (await load('timesheet_tab')).rows;
		expect(r!.cells[3]).toEqual({ kind: 'text', text: '2,5', flag: 'not a number; not counted' });
		expect(r!.cells[6]).toEqual({ kind: 'text', text: '', flag: 'not a number; not counted' });
		await clear('timesheet_tab');
	});

	it('say why an emptied edit or a deadline without title or date is not saved; an empty Add stays silent (D13)', async () => {
		await clear('popia_tab');
		await post('popia_tab', 'save', { activity: 'Synthetic activity' });
		const [r] = (await load('popia_tab')).rows;
		expect(await post('popia_tab', 'save', { rowId: r!.rowId, version: r!.version })).toMatchObject({ failed: 400, message: expect.stringMatching(/use Delete/) });
		expect(await post('popia_tab', 'save', {})).toEqual({ ok: true, saved: false });
		expect(await post('deadlines_tab', 'save', { title: 'Synthetic', cat: 'Filing' })).toMatchObject({ failed: 400, values: { title: 'Synthetic' }, message: expect.stringMatching(/^Title and Date must be filled in/) });
		expect((await load('popia_tab')).rows.map((x) => x.values.activity)).toEqual(['Synthetic activity']);
	});

	it('mark a row altered on disk since it was saved (D15)', async () => {
		await clear(D);
		await post(D, 'save', { ...v0, desc: 'Synthetic as saved' });
		const [r] = (await load(D)).rows;
		expect(r!.intact).toBe(true);
		lc.storage.db().prepare("UPDATE work.register_row SET fields = replace(fields, 'Synthetic as saved', 'Synthetic altered') WHERE row_id = ?").run(r!.rowId);
		expect((await load(D)).rows[0]).toMatchObject({ rowId: r!.rowId, intact: false, values: { desc: 'Synthetic altered' } });
	});

	it("refuse an edit naming another case's row with 404 and write nothing (D18)", async () => {
		await clear(D);
		const other = await lc.userWork.putRow('case-synthetic-other', 'disbursements', null, { ...v0, desc: 'Synthetic other case', seq: 1 });
		const [o] = lc.userWork.listRows('case-synthetic-other', 'disbursements');
		const { versionOf } = await import('../../src/lib/user-work/registers.server');
		expect(await post(D, 'save', { rowId: other, version: versionOf(o!), ...v0, desc: 'Synthetic hijack' })).toMatchObject({ failed: 404 });
		expect(lc.userWork.listRows('case-synthetic-other', 'disbursements').map((x) => x.fields.desc)).toEqual(['Synthetic other case']);
		expect((await load(D)).rows).toEqual([]);
	});

	it('report a failed delete as a delete, apart from any save failure (D4)', async () => {
		await clear(D);
		await post(D, 'save', v0);
		const [r] = (await load(D)).rows;
		const release = hold();
		let del;
		try { del = await post(D, 'delete', { rowId: r!.rowId }); } finally { release(); }
		expect(del).toMatchObject({ failed: 503, op: 'delete', rowId: r!.rowId, message: expect.stringMatching(/did not happen.*still there/) });
		expect((await load(D)).rows).toHaveLength(1);
	}, 60_000);
});
