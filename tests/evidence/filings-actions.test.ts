// The filings register's real load and add/save/delete actions on a synthetic case (GRS-14, CC-04 r2), driven as the
// page posts them. A refused Delete never returns values of its own: it returns the draft the form posted with it,
// unchanged, so a page re-rendered from it (without JavaScript) keeps the edit in progress (D1). A refused save names
// its operation, code and the row being edited, so the page stays in edit mode (D2, no JavaScript); a Delete also
// carries a failed save's code. A save made from an older version of the row (two tabs editing one row) is refused
// with its input kept, never a silent overwrite (D2, two-tab race). A Filing of spaces is accepted as v5 accepts it
// (D17). The busy store is held from outside the app (BEGIN IMMEDIATE on work.sqlite).
process.env.TZ = 'UTC';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';

let root: string, lc: LocalCase, rv: string, caseId: string;
let S: typeof import('../../src/lib/views/evidence/filings.server');
const env = { ...process.env };
beforeAll(async () => {
	root = await tempRoot('filings-actions');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	S = await import('../../src/lib/views/evidence/filings.server');
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

const page = () => new URL(`http://127.0.0.1/v/${rv}/evidence/filings_tab`);
type Out = { failed?: number; ok?: true; redirect?: string } & Record<string, unknown>;
/** One POST to a filings action, as the register form submits it. */
async function post(action: 'add' | 'save' | 'delete', fields: Record<string, string>): Promise<Out> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	const request = new Request(`${page()}?/${action}`, { method: 'POST', body: fd });
	try {
		const r = (await (S.filingsActions[action] as (e: unknown) => Promise<unknown>)({ params: { vid: rv }, request, url: page() })) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
		return r && typeof r.status === 'number' && 'data' in r ? { failed: r.status, ...r.data } : { ok: true, ...r };
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location };
		throw e;
	}
}
const entries = async () => (await S.filingsLoad({ parent: async () => ({ version: { id: rv, caseId } }), url: page() })).entries;
/** The row's version as an edit form loads it. */
const versionOf = async (key: string) => { const { rowVersion } = await import('../../src/lib/views/evidence/filings'); return rowVersion((await entries()).find((e) => e.key === key)!.fields); };
const hold = () => { const l = new DatabaseSync(lc.storage.workFile); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); return () => { l.exec('ROLLBACK'); l.close(); }; };
const blank = { filing: '', fdate: '', fparty: '', response: '', rdate: '', ref: '' };
const typed = { ...blank, filing: 'Unsaved edited filing', response: 'Unsaved edited reply' };

describe('filings register actions', () => {
	it('a Delete refused by a busy store returns the draft it was posted with, unchanged, and keeps the row (D1)', async () => {
		expect(await post('add', { ...blank, filing: 'Synthetic row one' })).toMatchObject({ ok: true, op: 'add', saved: true });
		expect(await post('add', { ...blank, filing: 'Synthetic row two' })).toMatchObject({ ok: true });
		const [one, two] = (await entries()).filter((e) => e.state === 'user');
		const release = hold();
		let r: Out;
		try { r = await post('delete', { key: one!.key, ...typed, delete: two!.key }); } finally { release(); }
		expect(r).toMatchObject({ failed: 503, op: 'delete', target: two!.key, draft: { values: typed, editing: one!.key, failed: null } });
		expect(r).not.toHaveProperty('values');
		expect(String(r.message)).toMatch(/^The entry could not be deleted: the local store is busy or unavailable\. Nothing was changed and the entry is still in the register/);
		expect((await entries()).map((e) => e.key)).toContain(two!.key);
	}, 60_000);

	it('a refused save of an edit names the row, its code and its values, so a page re-rendered from it stays in edit mode (D2)', async () => {
		const one = (await entries()).find((e) => e.fields.filing === 'Synthetic row one')!;
		const release = hold();
		let r: Out;
		const version = await versionOf(one.key);
		try { r = await post('save', { key: one.key, version, ...typed }); } finally { release(); }
		expect(r).toMatchObject({ failed: 503, op: 'save', code: 'busy', editing: one.key, version, values: typed, retry: true });
		expect((await entries()).find((e) => e.key === one.key)!.fields.filing).toBe('Synthetic row one');
		// an empty Filing is refused for the row being edited, not as an Add
		expect(await post('save', { key: one.key, version, ...blank })).toMatchObject({ failed: 400, op: 'save', code: 'empty-edit', editing: one.key, retry: false });
		expect(await post('add', blank)).toMatchObject({ failed: 400, op: 'save', code: 'empty-add', editing: null });
	}, 60_000);

	it('a Delete that is done returns the draft and a failed save code it carried, and refuses an unknown row apart (D2)', async () => {
		const [one, two] = (await entries()).filter((e) => e.state === 'user');
		const r = await post('delete', { key: one!.key, ...typed, failed: 'busy', delete: two!.key });
		expect(r).toMatchObject({ ok: true, op: 'delete', deleted: true, target: two!.key, draft: { values: typed, editing: one!.key, failed: 'busy' } });
		expect((await entries()).map((e) => e.key)).not.toContain(two!.key);
		// an unknown code is not carried
		expect(await post('delete', { ...typed, failed: '<b>x</b>', delete: 'row:none' })).toMatchObject({ failed: 404, op: 'delete', draft: { failed: null, editing: null } });
	});

	it('a save of a row deleted elsewhere is refused with its values kept, and never re-creates the row', async () => {
		const one = (await entries()).find((e) => e.fields.filing === 'Synthetic row one')!;
		expect(await post('delete', { delete: one.key })).toMatchObject({ ok: true });
		expect(await post('save', { key: one.key, ...typed })).toMatchObject({ failed: 404, op: 'save', code: 'gone', values: typed, editing: one.key });
		expect((await entries()).some((e) => e.key === one.key)).toBe(false);
	});

	it('accepts a Filing of spaces on Add and on Edit, untrimmed, as v5 does (D17)', async () => {
		expect(await post('add', { ...blank, filing: '   ' })).toMatchObject({ ok: true, op: 'add' });
		const row = (await entries()).find((e) => e.state === 'user' && e.fields.filing === '   ')!;
		expect(row).toBeTruthy();
		expect(await post('save', { key: row.key, version: await versionOf(row.key), ...blank, filing: '  ', response: 'Synthetic' })).toEqual({ redirect: page().pathname });
		expect((await entries()).find((e) => e.key === row.key)!.fields).toMatchObject({ filing: '  ', response: 'Synthetic' });
	});

	it('refuses a save made from an older version of the row, keeping its input, so a second tab never overwrites the first (two-tab race)', async () => {
		expect(await post('add', { ...blank, filing: 'Synthetic shared row' })).toMatchObject({ ok: true });
		const row = (await entries()).find((e) => e.fields.filing === 'Synthetic shared row')!;
		const seen = await versionOf(row.key); // both tabs open the row's Edit
		expect(await post('save', { key: row.key, version: seen, ...blank, filing: 'Synthetic shared row', response: 'First tab' })).toEqual({ redirect: page().pathname });
		const second = { ...blank, filing: 'Synthetic shared row', response: 'Second tab' };
		expect(await post('save', { key: row.key, version: seen, ...second })).toMatchObject({ failed: 409, op: 'save', code: 'stale', editing: row.key, values: second, retry: false });
		expect((await entries()).find((e) => e.key === row.key)!.fields.response).toBe('First tab');
		// a save without a version (not from this page) cannot be checked, so it is refused too
		expect(await post('save', { key: row.key, ...second })).toMatchObject({ failed: 409, code: 'stale' });
		// a seed is checked the same way
		const s1 = (await entries()).find((e) => e.key.startsWith('seed:'))!;
		const sv = await versionOf(s1.key);
		expect(await post('save', { key: s1.key, version: sv, ...blank, filing: s1.fields.filing, response: 'Seed first tab' })).toEqual({ redirect: page().pathname });
		expect(await post('save', { key: s1.key, version: sv, ...blank, filing: s1.fields.filing, response: 'Seed second tab' })).toMatchObject({ failed: 409, code: 'stale' });
	});
});
