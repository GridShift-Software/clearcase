// Ticket 17a fix round: a local delete that names the version the page showed is refused when the row changed since; the
// real register action on a synthetic case, as 17a's two tabs drive it.
process.env.TZ = 'UTC';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import { STALE_DELETE } from '../../src/lib/views/registers/shown';

let root: string, lc: LocalCase, rv: string, caseId: string;
let P: typeof import('../../src/lib/views/registers/page.server');
const env = { ...process.env };
beforeAll(async () => {
	root = await tempRoot('registers-delete-version');
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

const V = 'deadlines_tab' as const;
async function post(action: 'save' | 'delete', fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	const request = new Request(`http://127.0.0.1/v/${rv}/registers/${V}?/${action}`, { method: 'POST', body: fd });
	const r = (await (P.registerActions(V)[action] as (e: unknown) => Promise<unknown>)({ params: { vid: rv }, request })) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
	return r && typeof r.status === 'number' && 'data' in r ? { failed: r.status, ...r.data } : { ok: true, ...r };
}
const rows = async () => ((await P.registerLoad(V)({ parent: async () => ({ version: { id: rv, caseId } }) })) as { rows: { rowId: string; version: string; values: Record<string, string> }[] }).rows;
const entry = { title: 'Synthetic local deadline', date: '2026-11-04', cat: 'Filing', note: '' };

describe('a local delete that carries the version the page showed', () => {
	it('is refused when the row was edited after the confirmation rendered, and the newer row stays', async () => {
		await post('save', entry);
		const shown = (await rows())[0]!;
		await post('save', { ...entry, title: 'Edited in another tab', rowId: shown.rowId, version: shown.version });
		expect(await post('delete', { delete: shown.rowId, confirm: shown.rowId, deleteVersion: shown.version })).toMatchObject({ failed: 409, op: 'delete', rowId: shown.rowId, message: STALE_DELETE });
		expect((await rows()).map((r) => r.values.title)).toEqual(['Edited in another tab']);
	});
	it('deletes the row when the version is current, and a scripted post without one still deletes as before', async () => {
		const shown = (await rows())[0]!;
		expect(await post('delete', { delete: shown.rowId, confirm: shown.rowId, deleteVersion: shown.version })).toMatchObject({ ok: true, deleted: true });
		await post('save', entry);
		const next = (await rows())[0]!;
		expect(await post('delete', { delete: next.rowId, confirm: next.rowId })).toMatchObject({ ok: true, deleted: true });
		expect(await rows()).toEqual([]);
	});
});
