// The originals site's response policies, against a real listener on loopback: exact Host, lookup only through the
// verified mapping, verified bytes or 410, servePolicy headers, the cross-site and frame refusal, the link capability
// that survives a restart, and the verified-snapshot path for large originals.
import { readdir, rm, link, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase, hostileOriginals, hostileRows } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import { LinkCapability, OriginalsServer } from './originals.server.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
let root: string, lc: LocalCase, o: OriginalsServer, rv: string, caseDir: string, host: string, port: number;

beforeAll(async () => {
	root = await tempRoot('orig');
	port = await freePort();
	lc = service(path.join(root, 'data'), { ORIGINALS_PORT: String(port), CLEARCASE_BUFFER_MAX_BYTES: '64' });
	await lc.startup();
	const c = await buildCase(path.join(root, 'c'), { originals: hostileOriginals(), rows: hostileRows() });
	({ caseDir } = c);
	rv = c.resultsVersion;
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(rv, ackFor(lc, imp.importId))).toBeNull();
	o = new OriginalsServer(lc);
	await o.start();
	host = `clearcase-originals.localhost:${port}`;
});
afterAll(async () => { o?.close(); lc?.shutdown(); await cleanup(root); });

const get = (pathAndQuery: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { headers: { host, ...headers }, redirect: 'manual' });
const rel = (href: string) => href.slice(o.origin.length);
const name = (key: string) => lc.store.assetForServe(rv, key)!.real_path!.split('/').pop()!;

describe('presentation', () => {
	it('decides from the verified mapping: viewer for PDF, sandboxed text, inline images, download otherwise', () => {
		const p = (key: string) => OriginalsServer.presentation(lc.store.assetForServe(rv, key)!);
		expect(p('OD-001')).toBe('viewer');
		expect(p('EM-0001')).toBe('text');
		expect(p('HX-001')).toBe('text'); // HTML is shown as source text, never rendered
		expect(p('HX-002')).toBe('download'); // SVG is scriptable
		expect(p('HX-009')).toBe('inline');
		expect(p('HX-010')).toBe('download'); // content contradicts the declared type
		expect(p('EM-0002')).toBe('download'); // .msg
		expect(p('HX-004')).toBe('viewer'); // the polyglot sniffs as PDF: it may only reach pdf.js in the sandbox
	});
});

describe('serving', () => {
	it('refuses any other Host with 421, and non-GET methods', async () => {
		const href = rel(o.originalHref(rv, 'OD-001', name('OD-001')));
		expect((await get(href, { host: `localhost:${port}` })).status).toBe(421);
		expect((await get(href, { host: 'evil.example' })).status).toBe(421);
		expect((await fetch(`http://127.0.0.1:${port}${href}`, { method: 'POST', headers: { host } })).status).toBe(405);
	});

	it('serves verified bytes with servePolicy headers; raw PDF bytes are always an attachment', async () => {
		const r = await get(rel(o.originalHref(rv, 'OD-001', name('OD-001'))));
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toBe('application/octet-stream');
		expect(r.headers.get('content-disposition')).toMatch(/^attachment; /);
		for (const [h, v] of [['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['cache-control', 'private, no-store'], ['cross-origin-resource-policy', 'same-origin'], ['cross-origin-opener-policy', 'same-origin']])
			expect(r.headers.get(h)).toBe(v);
		expect(r.headers.get('content-security-policy')).toMatch(/sandbox/);
		const html = await get(rel(o.originalHref(rv, 'HX-001', name('HX-001'))));
		expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(html.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
		const png = await get(rel(o.originalHref(rv, 'HX-009', name('HX-009'))));
		expect([png.headers.get('content-type'), png.headers.get('content-disposition')?.split(';')[0]]).toEqual(['image/png', 'inline']);
		const fake = await get(rel(o.originalHref(rv, 'HX-010', name('HX-010'))));
		expect([fake.headers.get('content-type'), fake.headers.get('content-disposition')?.split(';')[0]]).toEqual(['application/octet-stream', 'attachment']);
	});

	it('looks up only (version, key): the name in the URL is ignored and unknown keys are 404, embedded ones 410', async () => {
		const r = await get(`/o/${rv}/OD-001/../../etc/passwd`);
		expect(r.status).toBe(404);
		const renamed = await get(`/o/${rv}/OD-001/whatever.html?k=${o.links.token(rv, 'OD-001')}`);
		expect(renamed.status).toBe(200);
		expect(renamed.headers.get('content-disposition')).toContain('OD-001 Supply agreement.pdf');
		expect((await get(`/o/${rv}/ZZ-001/x`)).status).toBe(404);
		expect((await get(`/o/${rv}/EM-0001.a1/x`)).status).toBe(410);
	});

	it('answers 410 before any header when the bytes changed, the file is a hard link, or it disappeared', async () => {
		const file = path.join(caseDir, 'DISCOVERY B', 'SD-001 Statement.pdf');
		const href = rel(o.originalHref(rv, 'SD-001', name('SD-001')));
		const original = Buffer.from(await (await get(href)).arrayBuffer());
		await writeFile(file, Buffer.from(original).fill(0x42, 12, 14));
		expect((await get(href)).status).toBe(410);
		await writeFile(file, original);
		expect((await get(href)).status).toBe(200);
		await link(file, path.join(root, 'outside-hardlink'));
		expect((await get(href)).status).toBe(410);
		await rm(path.join(root, 'outside-hardlink'));
		await rm(file);
		expect((await get(href)).status).toBe(410);
		await writeFile(file, original);
	});

	it('reports on-disk availability with the same reasons the serve path answers 410 with, without hashing', async () => {
		const file = path.join(caseDir, 'DISCOVERY B', 'SD-001 Statement.pdf');
		const href = rel(o.originalHref(rv, 'SD-001', name('SD-001')));
		const asset = () => { const a = lc.store.assetForServe(rv, 'SD-001')!; return { ...a, real_path: a.real_path!, size: a.size! }; };
		const original = Buffer.from(await (await get(href)).arrayBuffer());
		expect(await OriginalsServer.availability(asset())).toBeNull();
		await rm(file); // removed after activation
		expect(await OriginalsServer.availability(asset())).toEqual({ refused: 'missing', reason: 'missing on disk' });
		const r = await get(href);
		expect([r.status, await r.text()]).toEqual([410, 'original not available: missing on disk']);
		await writeFile(file, Buffer.concat([original, Buffer.from('x')]));
		expect(await OriginalsServer.availability(asset())).toEqual({ refused: 'size', reason: 'changed since import (size differs)' });
		await writeFile(file, Buffer.from(original).fill(0x42, 12, 14)); // same size, other bytes: only the serve-time hash catches it
		expect(await OriginalsServer.availability(asset())).toBeNull();
		await writeFile(file, original);
		expect(await OriginalsServer.availability(asset())).toBeNull();
		expect((await get(href)).status).toBe(200);
	});

	it('streams large originals only from a verified private snapshot and removes it', async () => {
		const href = rel(o.originalHref(rv, 'HX-001', name('HX-001'))); // > 64 bytes: the snapshot path
		const r = await get(href);
		expect(r.status).toBe(200);
		expect((await r.text()).startsWith('<!doctype html>')).toBe(true);
		expect(await readdir(lc.serveTmpDir)).toEqual([]);
	});

	it('gives one constant 403 to framed or cross-site requests without the link capability, before any lookup', async () => {
		const fr = { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' };
		const a = await get(rel(o.originalHref(rv, 'OD-001', name('OD-001'))), fr);
		const b = await get(`/o/${rv}/ZZ-999/x`, fr);
		expect([a.status, b.status]).toEqual([403, 403]);
		expect(await a.text()).toBe(await b.text());
		const noK = await get(`/o/${rv}/OD-001/x`, { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' });
		expect(noK.status).toBe(403);
		const withK = await get(rel(o.originalHref(rv, 'OD-001', name('OD-001'))), { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' });
		expect(withK.status).toBe(200);
		expect((await get(`/o/${rv}/OD-001/x`, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
	});

	it('keeps the link capability across a restart (the key lives in the data directory)', () => {
		const again = new LinkCapability(lc.config.dataDir);
		expect(again.token(rv, 'OD-001')).toBe(o.links.token(rv, 'OD-001'));
		expect(new LinkCapability(path.join(root, 'other-data')).token(rv, 'OD-001')).not.toBe(o.links.token(rv, 'OD-001'));
	});

	it('serves the viewer wrapper only for PDFs and only when the pdf.js bundle exists', async () => {
		const r = await get(rel(o.viewerHref(rv, 'EM-0001')));
		expect(r.status).toBe(404);
		expect((await get('/_pdfjs/6.4.299/constructor')).status).toBe(404);
	});
});
