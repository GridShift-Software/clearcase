// GRS-56 item 4 (RECHECK-21-r2 low 1): the court bundle page saves a v5-size bundle list. The route's own limits are 2 MB
// of item-list JSON and 5,000 rows; before this the app-wide 512 KiB body limit refused a list far below them. Driven over
// HTTP against the real routes (a Vite dev server in this process, as src/lib/local-case/ssr-pages.test.ts), a synthetic case.
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { createServer, type RunnableDevEnvironment, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, devServerLock, tempRoot } from '../../src/lib/local-case/test-support.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const freePort = () => new Promise<number>((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

let root: string, vite: ViteDevServer, http: Server, origin: string, rv: string, lc: LocalCase, caseId: string;
const saved = { ...process.env };

let unlock: (() => void) | undefined;
beforeAll(async () => {
	unlock = await devServerLock(ROOT);
	root = await tempRoot('court-save-limit');
	const [port, originalsPort] = [await freePort(), await freePort()];
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: String(port), ORIGINALS_PORT: String(originalsPort), CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	vite = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
	http = httpServer(vite.middlewares);
	await new Promise<void>((r) => http.listen(port, '127.0.0.1', r));
	origin = `http://127.0.0.1:${port}`;
	const health = await fetch(`${origin}/api/health`);
	expect(health.status, `Initial health response: ${await health.text()}`).toBe(200); // runs the server init (initApp)
	const { app } = (await (vite.environments.ssr as RunnableDevEnvironment).runner.import('/src/lib/local-case/app.server.ts')) as { app: () => LocalCase };
	lc = app();
	const c = await buildCase(path.join(root, 'c'));
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
}, 180_000);
afterAll(async () => {
	await vite?.close();
	await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
	try { lc?.shutdown(); } catch { /* closed */ }
	process.env = saved;
	if (root) await cleanup(root);
	unlock?.();
}, 60_000);

/** A bundle of `rows` items whose JSON is about `bytes` long. */
const bundle = (name: string, bytes: number, rows = 1000) => {
	const desc = 'x'.repeat(Math.max(1, Math.floor(bytes / rows) - 120));
	return JSON.stringify({ name, pages: rows, indexPages: 1, filePages: rows + 1, note: 'saved', rows: Array.from({ length: rows }, (_, k) => ({ n: k + 1, key: '', desc, pages: 1, from: k + 1, to: k + 1, parts: [] })) });
};
const save = (id: string, json: string) => {
	const form = new FormData();
	form.set('id', id);
	form.set('bundle', json);
	return fetch(`${origin}/v/${rv}/bundles/court_bundle_tab?/save`, { method: 'POST', body: form, headers: { origin, 'x-sveltekit-action': 'true' } });
};

describe('court bundle save limit', () => {
	it('a save of about 1 MB succeeds and keeps every item', async () => {
		const json = bundle('One megabyte', 1_000_000);
		expect(json.length).toBeGreaterThan(900_000);
		const res = await save('out-1mb', json);
		const body = await res.json() as { type: string; data?: string };
		expect([res.status, body.type]).toEqual([200, 'success']);
		const { readCustom } = (await (vite.environments.ssr as RunnableDevEnvironment).runner.import('/src/lib/views/bundles/store.server.ts')) as typeof import('../../src/lib/views/bundles/store.server.ts');
		const list = await readCustom(caseId);
		expect(list.map((c) => [c.id, c.name, c.rows.length])).toEqual([['out-1mb', 'One megabyte', 1000]]);
	}, 60_000);

	it('a save over 2 MiB is refused with 413 and the message that names the limit, and nothing is saved', async () => {
		const res = await save('out-big', bundle('Too big', 2_300_000));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ type: 'error', error: { message: 'request too large: this page accepts at most 2 MiB in one request' } });
		const { readCustom } = (await (vite.environments.ssr as RunnableDevEnvironment).runner.import('/src/lib/views/bundles/store.server.ts')) as typeof import('../../src/lib/views/bundles/store.server.ts');
		expect((await readCustom(caseId)).map((c) => c.id)).toEqual(['out-1mb']);
	}, 60_000);
});
