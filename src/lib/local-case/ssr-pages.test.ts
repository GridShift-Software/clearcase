// Full SSR page loads: the SvelteKit app runs in a Vite dev server in this process, so the test registers
// document-row providers in the same module graph the routes use. A degraded provider must never take a reader down
// (chronology page, its API, the overview, document pages): the pages answer 200 and say so. Import-time states are
// labelled as such (overview originals), and a container whose original is gone says its attachments are unavailable.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type * as Documents from './documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, tempRoot } from './test-support.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const freePort = () => new Promise<number>((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

let root: string, vite: ViteDevServer, http: Server, origin: string, rv: string, caseDir: string, lc: LocalCase;
let docs: typeof Documents;
const saved = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('ssr');
	const [port, originalsPort] = [await freePort(), await freePort()];
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: String(port), ORIGINALS_PORT: String(originalsPort), CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	vite = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
	http = httpServer(vite.middlewares);
	await new Promise<void>((r) => http.listen(port, '127.0.0.1', r));
	origin = `http://127.0.0.1:${port}`;
	expect((await fetch(`${origin}/api/health`)).status).toBe(200); // runs the server init (initApp)
	const { app } = (await vite.ssrLoadModule('/src/lib/local-case/app.server.ts')) as { app: () => LocalCase };
	docs = (await vite.ssrLoadModule('/src/lib/local-case/documents.server.ts')) as typeof Documents;
	lc = app();
	const c = await buildCase(path.join(root, 'c'));
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	caseDir = c.caseDir;
}, 120_000);

afterAll(async () => {
	await new Promise((r) => http?.close(r));
	await vite?.close();
	const g = globalThis as { __clearcase?: { app: LocalCase; originals: { close(): void } } };
	g.__clearcase?.originals.close();
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = saved;
	if (root) await cleanup(root);
});

const state: DocumentStateRow = { file: 'missing', preview: 'none', text: 'pending', mediaType: null, flags: ['rescan'], original: null, self: null };
const list = (ref: string): Omit<ChronologyListRow, 'ord'> => ({ ref, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Rescan', subject: 'new file', filename: 'new.pdf', sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'pending', parentRef: null, file: 'missing', preview: 'none', attachments: 0 });
const v = () => `/v/${encodeURIComponent(rv)}`;
const get = async (p: string) => { const r = await fetch(`${origin}${p}`); return { status: r.status, text: await r.text(), degraded: r.headers.get('x-clearcase-degraded') }; };

async function withProvider(p: Omit<Documents.DocumentRowProvider, 'id' | 'owner'>, fn: () => Promise<void>) {
	const undo = docs.registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', ...p });
	try { await fn(); } finally { undo(); }
}

describe('SSR readers with a degraded document-row provider', () => {
	it('rows() throws: the chronology page (full SSR load) answers 200 with the degraded banner, as do the API and the overview', async () => {
		await withProvider({ revision: () => 'r1', rows: () => { throw new Error('rescan index unreadable'); } }, async () => {
			const api = await get(`/api/v/${encodeURIComponent(rv)}/chronology`);
			expect([api.status, api.degraded !== null]).toEqual([200, true]);
			const page = await get(`${v()}/chronology`);
			expect(page.status).toBe(200);
			expect(page.text).toContain('id="degraded-documents"');
			expect(page.text).toContain('rescan index unreadable');
			const ov = await get(`${v()}/overview`);
			expect([ov.status, ov.text.includes('id="degraded-documents"')]).toEqual([200, true]);
		});
	});

	it('revision() throws: the provider is reported as failed, with the header and the banner', async () => {
		await withProvider({ revision: () => { throw new Error('revision unreadable'); }, rows: () => [{ ref: 'RS-001', row: { ref: 'RS-001' }, list: list('RS-001'), state }] }, async () => {
			const api = await get(`/api/v/${encodeURIComponent(rv)}/chronology`);
			expect(api.status).toBe(200);
			expect(JSON.parse(decodeURIComponent(api.degraded ?? '[]'))).toEqual([{ source: 'provider:rescan', owner: 'GRS-20', reason: 'revision unreadable' }]);
			const page = await get(`${v()}/chronology`);
			expect(page.status).toBe(200);
			expect(page.text).toContain('revision unreadable');
			expect((await get(`${v()}/overview`)).text).toContain('id="degraded-documents"');
		});
	});

	it('malformed provider rows are dropped: the API, overview, chronology and document pages never answer 500', async () => {
		const rows = () => [null, 42, { ref: 'RS-002' }, { ref: 'RS-003', row: {}, list: { ...list('RS-003'), alsoIn: null }, state }, { ref: 'RS-004', row: { n: 1n }, list: list('RS-004'), state },
			{ ref: 'RS-001', row: { ref: 'RS-001' }, list: list('RS-001'), state }] as never;
		await withProvider({ revision: () => 'r1', rows }, async () => {
			const api = await get(`/api/v/${encodeURIComponent(rv)}/chronology`);
			expect(api.status).toBe(200);
			expect((JSON.parse(api.text) as ChronologyListRow[]).map((r) => r.ref).filter((r) => r.startsWith('RS-'))).toEqual(['RS-001']);
			for (const p of ['/chronology', '/overview', '/doc/RS-001', '/doc/OD-001']) expect([p, (await get(`${v()}${p}`)).status]).toEqual([p, 200]);
			const r = docs.documentRows(lc.store, rv);
			expect(r.dropped.map((d) => [d.ref, d.reason.startsWith('malformed row')])).toEqual([['#0', true], ['#1', true], ['RS-002', true], ['RS-003', true], ['RS-004', true]]);
		});
	});
});

describe('SSR pages: import-time and parent-original states', () => {
	it('labels the overview originals counts as checked at import, with the import time', async () => {
		const ov = await get(`${v()}/overview`);
		const storedAt = lc.store.getVersion(rv)!.stored_at;
		expect(ov.text).toMatch(new RegExp(`id="originals-checked"[^]*?Checked when this version was imported[^]*?<time datetime="${storedAt.replace(/[.+]/g, '\\$&')}"`));
	});

	it('a container whose original is missing on disk says its embedded attachments are unavailable', async () => {
		const page = `${v()}/doc/EM-0001`;
		const before = (await get(page)).text;
		expect(before).toMatch(/data-route="parent"[^]*?the parent original<\/a> to reach it/);
		const { original } = JSON.parse(lc.store.document(rv, 'EM-0001')!.state_json) as DocumentStateRow;
		const file = path.join(caseDir, ...original!.path.split('/'));
		const bytes = readFileSync(file);
		rmSync(file);
		try {
			const after = await get(page);
			expect(after.status).toBe(200);
			const rows = [...after.text.matchAll(/<li data-attachment="[^"]*" data-route="parent">([^]*?)<\/li>/g)].map((m) => m[1]!);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) {
				expect(r).toContain('data-parent="unavailable"');
				expect(r).toContain('the parent original is unavailable');
				expect(r).not.toContain('to reach it');
			}
		} finally { writeFileSync(file, bytes); }
	});
});
