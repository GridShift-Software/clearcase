// Full SSR page loads: the SvelteKit app runs in a Vite dev server in this process, so the test registers
// document-row providers in the same module graph the routes use. A degraded provider must never take a reader down
// (chronology page, its API, the overview, document pages): the pages answer 200 and say so. Import-time states are
// labelled as such (overview originals), and a container whose original is gone says its attachments are unavailable.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type * as Documents from './documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, devServerLock, tempRoot } from './test-support.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const freePort = () => new Promise<number>((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

let root: string, vite: ViteDevServer, http: Server, origin: string, rv: string, caseDir: string, lc: LocalCase;
let docs: typeof Documents;
const saved = { ...process.env };

let unlock: (() => void) | undefined;
beforeAll(async () => {
	unlock = await devServerLock(ROOT);
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
	unlock?.();
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

describe('SSR document page: every action it offers succeeds on the real write path', () => {
	/** Submit the page's note form as the browser does; null when the page offers none. */
	const note = async (ref: string) => {
		const page = await get(`${v()}/doc/${ref}`);
		if (!page.text.includes('id="note-form"')) return { offered: false, status: 0, text: '', page };
		const r = await fetch(`${origin}${v()}/doc/${ref}?/note`, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ body: 'a plainly invented note' }) });
		return { offered: true, status: r.status, text: await r.text(), page };
	};
	it('a provider-only document offers no note form and says why; an imported one offers it and saving works', async () => {
		await withProvider({ revision: () => 'r1', rows: () => [{ ref: 'RS-001', row: { ref: 'RS-001' }, list: list('RS-001'), state }] }, async () => {
			const prov = await note('RS-001');
			expect(prov.page.status).toBe(200);
			// either the form is offered and saves, or it is not offered and the page says why
			if (prov.offered) expect([prov.status, prov.text.includes('No such document')]).toEqual([200, false]);
			else expect(prov.page.text).toContain('id="note-unavailable"');
			const imp = await note('OD-001');
			expect(imp.offered).toBe(true);
			expect([imp.status, imp.text.includes('No such document')]).toEqual([200, false]);
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
		expect(before).toMatch(/data-route="parent"[^]*?>the parent original<\/a>/);
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
				expect(r).not.toContain('</a>');
			}
		} finally { writeFileSync(file, bytes); }
	});
});

describe('/api/browse: the Import page folder browser (GRS-70)', () => {
	const browse = (headers: Record<string, string>, dir = root) => fetch(`${origin}/api/browse?path=${encodeURIComponent(dir)}`, { headers });

	it('lists a folder to a same-origin request and refuses a cross-site or same-site one before reading anything', async () => {
		const ok = await browse({ 'sec-fetch-site': 'same-origin' });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('cache-control')).toBe('no-store');
		const l = await ok.json();
		expect(l.path).toBe(root);
		expect(l.entries.map((e: { name: string }) => e.name)).toContain('data');
		for (const site of ['cross-site', 'same-site']) {
			const r = await browse({ 'sec-fetch-site': site });
			expect([site, r.status, await r.text()]).toEqual([site, 403, 'cross-site API request refused']);
		}
	});

	it('answers GET only: a write to it is refused', async () => {
		const r = await fetch(`${origin}/api/browse`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
		expect(r.status).toBe(405);
	});
});

describe('hooks.server.ts: loopback clients only, and a disk-full diagnostic', () => {
	type Hooks = typeof import('../../hooks.server.ts');
	const event = (addr: string | (() => string)) => {
		const url = new URL(`${origin}/api/health`);
		return { url, isSubRequest: false, request: new Request(url, { headers: { host: url.host } }), getClientAddress: typeof addr === 'string' ? () => addr : addr } as never;
	};
	const handle = async (addr: string | (() => string)) => {
		const { handle } = (await vite.ssrLoadModule('/src/hooks.server.ts')) as Hooks;
		let resolved = false;
		const res = await handle({ event: event(addr), resolve: async () => { resolved = true; return new Response('routed'); } });
		return { status: res.status, resolved, text: await res.text() };
	};

	it('refuses a request from a non-loopback client address with 403 before routing', async () => {
		for (const addr of ['10.99.0.1', '192.168.1.20', '::ffff:10.99.0.1', 'fe80::1', '2001:db8::1', '0.0.0.0', '128.0.0.1', '']) {
			const r = await handle(addr);
			expect([addr, r.status, r.resolved]).toEqual([addr, 403, false]);
			expect(r.text).toMatch(/loopback/);
		}
		const unknown = await handle(() => { throw new Error('no address'); });
		expect([unknown.status, unknown.resolved]).toEqual([403, false]);
	});

	it('routes a request from a loopback client address (127.0.0.0/8, ::1, ::ffff:127.x)', async () => {
		for (const addr of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
			const r = await handle(addr);
			expect([addr, r.status, r.resolved]).toEqual([addr, 200, true]);
		}
	});

	it('names a full disk instead of a generic internal error', async () => {
		const { handleError } = (await vite.ssrLoadModule('/src/hooks.server.ts')) as Hooks;
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const msg = (error: unknown) => (handleError({ error, event: event('127.0.0.1'), status: 500, message: 'Internal Error' }) as { message: string }).message;
		try {
			expect(msg(Object.assign(new Error('database or disk is full'), { errcode: 13 }))).toMatch(/disk holding the ClearCase data directory is full/);
			expect(msg(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).toMatch(/is full/);
			expect(msg(new Error('something else'))).toBe('Internal error');
		} finally { err.mockRestore(); }
	});
});
