// The read-only tour proxy (scripts/demo/tour-proxy.ts): its rules on every encoding of a refused route, its Basic
// auth on odd credentials, and the real process against a loopback upstream that records what reaches it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorised, canonicalPath, refused } from '../../scripts/demo/tour-policy.ts';
import { versionPath } from '../../src/lib/local-case/model.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const BUN = process.versions.bun ? process.execPath : 'bun';
const b64 = (s: string) => `Basic ${Buffer.from(s, 'utf8').toString('base64')}`;
/** A version's path as the app links it: encodeURIComponent keeps the colon of 'sha256:<hex>' as %3A, which
 *  decodeURI preserves. VP_LOWER is the same path as a client that lowercases its escapes sends it. */
const VP = versionPath('sha256:' + 'a1'.repeat(32));
const VP_LOWER = VP.replace('%3A', '%3a');
const VP_DOUBLE = VP.replace('%3A', '%253A');

/** Each refused route in its plain form and in the percent-encoded forms SvelteKit decodes before routing. */
const REFUSED_FORMS: [string, string][] = [
	['/import', '/%69mport'], ['/import/', '/import%2F'.replace('%2F', '/')], ['/import/x', '/%69mport/x'], ['/import?x=1', '/%69mport?x=1'],
	['/api/browse', '/api/%62rowse'], ['/api/browse?path=%2Fhome', '/api/br%6Fwse?path=%2Fhome'],
	['/api/import-progress', '/api/%69mport%2Dprogress'],
	['/recovery', '/%72ecovery'], ['/recovery/', '/rec%6Fvery/'],
	['/v/abc/system/', '/v/abc/%73ystem/'], ['/v/abc/system', '/v/abc/sy%73tem'], ['/v/abc/system/backup_tab/download', '/v/abc/%73ystem/backup_tab/download'],
	[`${VP}/system/`, `${VP_LOWER}/%73ystem/`], [`${VP}/system`, `${VP}/sy%73tem`], [`${VP}/system/backup_tab/download`, `${VP_LOWER}/system/backup_tab/download`],
];
const ALLOWED = ['/', '/cases', '/v/abc/overview', '/v/abc/doc/OD-002?q=%41&page=2', '/_app/immutable/entry.js', '/fonts/x.woff2', '/api/health', '/v/abc/documents', '/importance', '/v/abc/systems',
	`${VP}/overview`, `${VP_LOWER}/overview`, `${VP}/doc/OD-002?q=%41&page=2`, `${VP}/documents`, `${VP}/systems`];
const MALFORMED = ['/%ZZ', '/import%', '/%E0%A4%A', 'import', '', '//v/../import'.slice(1), '/v/abc/../import', '/v/abc/%2E%2E/import', '/v/abc/./system/', '/v/abc/%2Fsystem/', '/%2525import', '/v\\abc', '/import%0A', '/v/abc/%7Fsystem',
	`${VP_DOUBLE}/overview`, `${VP_DOUBLE}/system/`, `${VP.replace('%3A', '%253a')}/overview`, `${VP.replace('%3A', '%3A%2F')}/overview`, `${VP.replace('%3A', '%3A%25')}/overview`];

describe('tour-policy: canonical path and refused routes', () => {
	for (const [plain, encoded] of REFUSED_FORMS) {
		it(`refuses ${plain} and its encoded form ${encoded}`, () => {
			for (const form of [plain, encoded]) {
				const c = canonicalPath(form);
				expect(c, form).not.toBeNull();
				expect(refused(c!), form).toBe(true);
			}
		});
	}
	it('passes the routes a visitor reads, and lookalikes that are not the refused routes', () => {
		for (const form of ALLOWED) {
			const c = canonicalPath(form);
			expect(c, form).not.toBeNull();
			expect(refused(c!), form).toBe(false);
		}
	});
	it('rejects malformed, double-encoded, dot-segment, backslash and control-character paths', () => {
		for (const form of MALFORMED) expect(canonicalPath(form), JSON.stringify(form)).toBeNull();
	});
	it('decodes as SvelteKit does: unreserved characters decode, %25 and reserved sequences survive', () => {
		expect(canonicalPath('/v/abc/d%6Fc/OD-002?x=%2F')).toBe('/v/abc/doc/OD-002');
		expect(canonicalPath('/v/abc/doc/OD%2D002')).toBe('/v/abc/doc/OD-002');
		expect(canonicalPath('/v/abc/%25')).toBeNull();
	});
	it('keeps the encoded colon of a real version path, in either case, so the generated overview and system URLs route', () => {
		expect(canonicalPath(`${VP}/overview`)).toBe(`${VP}/overview`);
		expect(canonicalPath(`${VP_LOWER}/overview`)).toBe(`${VP_LOWER}/overview`);
		expect(refused(canonicalPath(`${VP}/system/`)!)).toBe(true);
		expect(canonicalPath(`${VP_DOUBLE}/overview`)).toBeNull();
	});
});

describe('tour-policy: Basic auth', () => {
	const ok = (h: string | undefined) => authorised(h, 'tour', 'pw-ß');
	it('accepts the exact user and password, with colons in the password', () => {
		expect(ok(b64('tour:pw-ß'))).toBe(true);
		expect(authorised(b64('tour:a:b'), 'tour', 'a:b')).toBe(true);
	});
	it('refuses, without throwing, credentials whose byte length differs from their string length', () => {
		expect(ok(b64('töur:pw-ß'))).toBe(false); // same string length as "tour", one more byte
		expect(ok(b64('tour:pw-s'))).toBe(false); // same string length as the password, one byte fewer
		expect(ok(b64('tour:pw-ßß'))).toBe(false);
	});
	it('refuses a missing, non-Basic, undecodable or colon-less header', () => {
		for (const h of [undefined, '', 'Bearer x', 'Basic', 'Basic ', 'Basic !!!!', b64('tour'), b64(':pw-ß'), b64('TOUR:pw-ß'), b64('tour:'), 'basic ' + b64('tour:pw-ß').slice(6)]) expect(ok(h), String(h)).toBe(false);
	});
});

describe('tour-proxy against a loopback upstream', () => {
	let upstream: Server, proxy: ChildProcess, base = '', seen: string[] = [], log = '';
	const auth = { authorization: b64('tour:secret') };
	const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: 'manual', ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });

	beforeAll(async () => {
		upstream = createServer((req, res) => { seen.push(`${req.method} ${req.url} host=${req.headers.host} auth=${req.headers.authorization ?? '-'}`); res.writeHead(200, { 'content-type': 'text/plain' }).end(`up ${req.url}`); });
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
		const upPort = (upstream.address() as { port: number }).port;
		proxy = spawn(BUN, [path.join(REPO, 'scripts/demo/tour-proxy.ts')], { cwd: REPO, env: { ...process.env, TOUR_PORT: '0', UPSTREAM_PORT: String(upPort), TOUR_USER: 'tour', TOUR_PASSWORD: 'secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
		proxy.stderr!.on('data', (d) => { log += d; });
		base = await new Promise<string>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`tour proxy did not start: ${log}`)), 15_000);
			let out = '';
			proxy.stdout!.on('data', (d) => { out += d; const m = /tour proxy on (http:\/\/127\.0\.0\.1:\d+)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]!); } });
			proxy.on('exit', (code) => { clearTimeout(t); reject(new Error(`tour proxy exited ${code}: ${log}`)); });
		});
	}, 20_000);
	afterAll(async () => {
		proxy?.kill();
		await new Promise<void>((r) => upstream?.close(() => r()));
	});

	it('forwards an allowed page with the request-target as sent, the upstream host, and no credentials', async () => {
		seen = [];
		const r = await get('/v/abc/doc/OD-002?q=%41');
		expect([r.status, await r.text()]).toEqual([200, 'up /v/abc/doc/OD-002?q=%41']);
		expect(seen).toEqual([`GET /v/abc/doc/OD-002?q=%41 host=${new URL(base).host.replace(/:\d+$/, '')}:${(upstream.address() as { port: number }).port} auth=-`]);
		expect((await get('/cases', { method: 'HEAD' })).status).toBe(200);
	});
	it('forwards a real version\'s overview and document pages with the encoded colon as sent, and refuses its system views', async () => {
		seen = [];
		for (const target of [`${VP}/overview`, `${VP_LOWER}/overview`, `${VP}/doc/OD-002?q=%41`]) {
			const r = await get(target);
			expect([r.status, await r.text()], target).toEqual([200, `up ${target}`]);
		}
		expect(seen.map((s) => s.split(' ')[1])).toEqual([`${VP}/overview`, `${VP_LOWER}/overview`, `${VP}/doc/OD-002?q=%41`]);
		seen = [];
		for (const target of [`${VP}/system/`, `${VP_LOWER}/system/`, `${VP}/%73ystem/`, `${VP}/system/backup_tab/download`]) expect((await get(target)).status, target).toBe(403);
		for (const target of [`${VP_DOUBLE}/overview`, `${VP_DOUBLE}/system/`]) expect((await get(target)).status, target).toBe(400);
		expect(seen).toEqual([]);
	});
	it('refuses every refused route in its plain and encoded forms with 403 and never asks the upstream', async () => {
		seen = [];
		for (const [plain, encoded] of REFUSED_FORMS) for (const form of [plain, encoded]) expect((await get(form)).status, form).toBe(403);
		expect(seen).toEqual([]);
	});
	/** The status line for a request-target sent as is: fetch would resolve "/v/abc/%2E%2E/import" to "/v/import" itself. */
	const rawStatus = (target: string) => new Promise<number>((resolve, reject) => {
		const { hostname, port } = new URL(base);
		const sock = connect(Number(port), hostname, () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAuthorization: ${auth.authorization}\r\nConnection: close\r\n\r\n`));
		let out = '';
		sock.on('data', (d) => { out += d; });
		sock.on('end', () => { const m = /^HTTP\/1\.1 (\d{3})/.exec(out); m ? resolve(Number(m[1])) : reject(new Error(`no status line in ${JSON.stringify(out)}`)); });
		sock.on('error', reject);
	});
	it('answers 400 to malformed, dot-segment or ambiguous paths without asking the upstream', async () => {
		seen = [];
		for (const form of ['/%ZZ', '/v/abc/%2Fsystem/', '/%2525import', '/import%']) expect((await get(form)).status, form).toBe(400);
		for (const form of ['/v/abc/%2E%2E/import', '/v/abc/../import', '/v/abc/./system/', '/v\\abc', '/import%0A']) expect(await rawStatus(form), form).toBe(400);
		expect(seen).toEqual([]);
	});
	it('allows only GET and HEAD', async () => {
		seen = [];
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
			const r = await get('/cases', { method, body: method === 'OPTIONS' ? undefined : 'x' });
			expect([r.status, r.headers.get('allow')], method).toEqual([405, 'GET, HEAD']);
		}
		expect(seen).toEqual([]);
	});
	it('answers 401 to missing, wrong, non-ASCII and undecodable credentials, and keeps serving afterwards', async () => {
		seen = [];
		for (const h of [undefined, 'Basic !!!!', b64('töur:secret'), b64('tour:secre'), b64('tour:secrets'), b64('tour:sécret'), b64('tour'), 'Bearer secret']) {
			const r = await fetch(base + '/cases', { headers: h === undefined ? {} : { authorization: h } });
			expect([r.status, r.headers.get('www-authenticate')], String(h)).toEqual([401, 'Basic realm="ClearCase tour", charset="UTF-8"']);
		}
		expect(seen).toEqual([]);
		expect(proxy.exitCode).toBeNull();
		expect((await get('/cases')).status).toBe(200);
	});
});
