// Helpers for tests/e2e/pilot/durability.mjs: servers with their own ports and logs, the originals site over
// node:http (exact Host, streaming, aborts, latency), direct read-mostly store inspection with node:sqlite, sparse
// and random files, /proc counters, and package variants built from GRS-10's real converter output.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { client, decodeHtml } from '../lib/client.mjs';
import { BUN, startServer } from '../lib/server.mjs';

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const vp = (rv) => `/v/${encodeURIComponent(rv)}`;
export const enc = (s) => new TextEncoder().encode(s);

// ---- ports: 43300..43597 in pairs (app, originals) ------------------------------------------------------------------
let slot = 0;
export const nextPorts = () => { const p = 43300 + 2 * (slot++ % 149); return { port: p, origPort: p + 1 }; };
export const bindRetries = { busyBeforeStart: 0, eaddrinuse: 0 };
export const portFree = (port) => new Promise((res) => { const srv = net.createServer(); srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => srv.close(() => res(true))); });

// ---- servers -----------------------------------------------------------------------------------------------------
export function serverPool({ root, buildDir, logDir }) {
	mkdirSync(logDir, { recursive: true });
	const live = new Set();
	const logs = new Set();
	let n = 0;
	// Ports 43300-43597 lie inside Linux's ephemeral range (32768-60999), so a client socket of this process can hold
	// one of them as its local port at any moment. A pair is checked free before use, and a start that still loses
	// the race (EADDRINUSE, logged by the server) is retried on the next free pair; every retry is counted.
	async function up(dataDir, { env = {}, ports = nextPorts(), name = 'srv', timeoutMs } = {}) {
		for (let attempt = 0; ; attempt++) {
			while (!((await portFree(ports.port)) && (await portFree(ports.origPort)))) { bindRetries.busyBeforeStart++; ports = nextPorts(); }
			const logFile = join(logDir, `${String(++n).padStart(3, '0')}-${name}-${ports.port}.log`);
			logs.add(logFile);
			try { return await upOn(dataDir, { env, ports, timeoutMs, logFile }); }
			catch (e) {
				let log = ''; try { log = readFileSync(logFile, 'utf8'); } catch {}
				if (attempt < 3 && /EADDRINUSE/.test(log)) { bindRetries.eaddrinuse++; ports = nextPorts(); continue; }
				throw e;
			}
		}
	}
	async function upOn(dataDir, { env, ports, timeoutMs, logFile }) {
		const s = await startServer({ root, port: ports.port, origPort: ports.origPort, dataDir, buildDir, logFile, env, timeoutMs });
		live.add(s);
		const stop = s.stop.bind(s);
		s.stop = async (sig, t) => { const r = await stop(sig, t); live.delete(s); return r; };
		Object.assign(s, { c: client(ports.port), o: originalsClient(ports.origPort), logFile, ports, dataDir });
		s.log = () => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } };
		return s;
	}
	/** Spawn the entry directly and wait for it to exit on its own (second-instance checks). */
	async function spawnExpectExit(dataDir, { env = {}, ports = nextPorts(), name = 'second', waitMs = 8000 } = {}) {
		const logFile = join(logDir, `${String(++n).padStart(3, '0')}-${name}-${ports.port}.log`);
		logs.add(logFile);
		const t0 = performance.now();
		const p = spawn(BUN, [join(root, 'scripts', 'pilot', 'start.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
			env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(ports.port), ORIGINALS_PORT: String(ports.origPort), CLEARCASE_DATA_DIR: dataDir, BUILD_DIR: buildDir, CLEARCASE_OFFLINE: process.env.CLEARCASE_OFFLINE ?? '', ...env } });
		let out = '';
		p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
		const exit = await new Promise((res) => { const t = setTimeout(() => res(null), waitMs); p.once('exit', (code, sig) => { clearTimeout(t); res({ code, sig, ms: Math.round(performance.now() - t0) }); }); });
		if (!exit) { p.kill('SIGKILL'); await new Promise((r) => p.once('exit', r)); }
		try { writeFileSync(logFile, out); } catch {}
		return { exitedOnItsOwn: !!exit, exit, log: out };
	}
	return {
		up, spawnExpectExit, live, logs,
		async killAll() { for (const s of [...live]) await s.stop('SIGKILL').catch(() => {}); },
		tails(max = 2500) { return [...logs].map((f) => { let t = ''; try { t = readFileSync(f, 'utf8'); } catch {} return { log: f.split('/').at(-1), tail: t.slice(-max) }; }); },
		reset() { logs.clear(); },
	};
}

// ---- app pages ---------------------------------------------------------------------------------------------------
export async function noteAdd(s, rv, ref, body) {
	const params = new URLSearchParams({ body });
	try {
		const r = await fetch(`${s.c.origin}${vp(rv)}/doc/${ref}?/note`, { method: 'POST', redirect: 'manual', body: params,
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: s.c.origin, 'x-sveltekit-action': 'true', accept: 'application/json' } });
		const text = await r.text();
		return { status: r.status, ok: r.status === 200 && /"type":"success"/.test(text), text: text.slice(0, 300), retryAfter: r.headers.get('retry-after') };
	} catch (e) { return { status: 0, ok: false, text: String(e?.cause?.code ?? e?.code ?? e) }; }
}
export async function notesOn(s, rv, ref) {
	const r = await s.c.get(`${vp(rv)}/doc/${ref}`);
	return {
		status: r.status, html: r.text,
		notes: [...r.text.matchAll(/<li data-note="([^"]+)" data-anchor="([a-z]+)"><span class="wrap">([^<]*)<\/span>/g)].map((m) => ({ id: m[1], anchor: m[2], body: decodeHtml(m[3]) })),
	};
}
/** Path (with link capability) of the download link the doc page renders for `ref`. */
export async function originalPath(s, rv, ref) {
	const r = await s.c.get(`${vp(rv)}/doc/${ref}`);
	const hrefs = [...r.text.matchAll(/href="(http:\/\/clearcase-originals\.localhost:\d+\/o\/[^"]+)"/g)].map((x) => decodeHtml(x[1]));
	if (!hrefs.length) return null;
	const u = new URL(hrefs[0]);
	return u.pathname + u.search;
}
export const activeVersion = (s) => s.c.activeVersion();
export async function rootHops(s, max = 12) {
	let loc = '/', hops = 0, last = null;
	for (; hops < max; hops++) { const r = await s.c.get(loc); last = r.status; if (r.status < 300 || r.status >= 400) break; loc = new URL(r.location, s.c.origin).pathname; }
	return { hops, final: loc, status: last };
}

// ---- originals site ----------------------------------------------------------------------------------------------
export function originalsClient(origPort) {
	const host = `clearcase-originals.localhost:${origPort}`;
	/** GET with timings; the body is hashed while it streams (never buffered when `keep` is false). */
	const get = (path, { headers = {}, keep = true, timeout = 120000 } = {}) => new Promise((resolve) => {
		const t0 = performance.now();
		const h = createHash('sha256');
		const chunks = [];
		let size = 0, ttfb = null;
		const req = http.request({ host: '127.0.0.1', port: origPort, path, method: 'GET', headers: { host, ...headers }, agent: false }, (res) => {
			ttfb = performance.now() - t0;
			res.on('data', (c) => { size += c.length; h.update(c); if (keep) chunks.push(c); });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, size, sha256: h.digest('hex'), body: keep ? Buffer.concat(chunks) : null, ttfbMs: ttfb, totalMs: performance.now() - t0, complete: true }));
			res.on('error', (e) => resolve({ status: res.statusCode, headers: res.headers, size, error: String(e.code ?? e), ttfbMs: ttfb, totalMs: performance.now() - t0, complete: false }));
			res.on('aborted', () => {});
		});
		req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
		req.on('error', (e) => resolve({ status: 0, error: String(e.code ?? e.message), size, ttfbMs: ttfb, totalMs: performance.now() - t0, complete: false }));
		req.end();
	});
	/** Raw request that disconnects after the first body bytes arrive. */
	const abortAfterFirstChunk = (path) => new Promise((res) => {
		const sock = net.connect(origPort, '127.0.0.1');
		let seen = '';
		const t = setTimeout(() => { sock.destroy(); res({ aborted: false, reason: 'timeout' }); }, 10000);
		sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`));
		sock.on('data', (d) => {
			seen += d.subarray(0, 64).toString('latin1');
			const head = /^HTTP\/1\.1 (\d+)/.exec(seen);
			// abort once headers and some body have arrived
			if (head) { clearTimeout(t); sock.destroy(); res({ aborted: true, status: Number(head[1]) }); }
		});
		sock.on('error', (e) => { clearTimeout(t); res({ aborted: false, reason: String(e.code ?? e) }); });
	});
	return { host, get, abortAfterFirstChunk };
}

// ---- stores ------------------------------------------------------------------------------------------------------
/** Open results.sqlite (+ work.sqlite if present) of a data directory. Never creates either file. */
export function openDb(dataDir, { readOnly = false } = {}) {
	const rf = join(dataDir, 'results.sqlite');
	if (!existsSync(rf)) throw new Error(`no results.sqlite in ${dataDir}`);
	const d = new DatabaseSync(rf, { readOnly });
	d.exec('PRAGMA busy_timeout=5000');
	const wf = join(dataDir, 'work.sqlite');
	if (existsSync(wf)) d.prepare('ATTACH DATABASE ? AS work').run(wf);
	return d;
}
export function q(dataDir, sql, ...args) { const d = openDb(dataDir); try { return d.prepare(sql).all(...args).map((r) => ({ ...r })); } finally { d.close(); } }
export function q1(dataDir, sql, ...args) { return q(dataDir, sql, ...args)[0]; }
export function withDb(dataDir, fn) { const d = openDb(dataDir); try { return fn(d); } finally { d.close(); } }
export const MAIN_TABLES = ['import_attempt', 'version', 'retired_version', 'package_file', 'document', 'asset', 'seed'];
export const WORK_TABLES = ['active', 'activation_log', 'trusted_warning', 'note', 'seed_overlay', 'register_row'];
export function tableCounts(dataDir) {
	return withDb(dataDir, (d) => Object.fromEntries([...MAIN_TABLES.map((t) => [t, `main.${t}`]), ...WORK_TABLES.map((t) => [`work.${t}`, `work.${t}`])]
		.map(([k, t]) => [k, Number(Object.values(d.prepare(`SELECT count(*) AS n FROM ${t}`).get())[0])])));
}
export function integrity(dataDir) {
	return withDb(dataDir, (d) => ({
		main: String(Object.values(d.prepare('PRAGMA main.integrity_check').get())[0]),
		work: String(Object.values(d.prepare('PRAGMA work.integrity_check').get())[0]),
		orphans: Number(Object.values(d.prepare(`SELECT (SELECT count(*) FROM package_file WHERE version_id NOT IN (SELECT id FROM version)) + (SELECT count(*) FROM document WHERE version_id NOT IN (SELECT id FROM version))
			+ (SELECT count(*) FROM asset WHERE version_id NOT IN (SELECT id FROM version)) + (SELECT count(*) FROM seed WHERE version_id NOT IN (SELECT id FROM version))
			+ (SELECT count(*) FROM version WHERE import_id NOT IN (SELECT id FROM import_attempt)) AS n`).get())[0]),
	}));
}
export const backupsIn = (dataDir) => { try { return readdirSync(join(dataDir, 'backups')).filter((n) => /^work-.*\.sqlite$/.test(n)).sort(); } catch { return []; } };
export function readBackup(file) {
	const d = new DatabaseSync(file, { readOnly: true });
	try {
		return {
			active: d.prepare('SELECT case_id, version_id FROM active').all().map((r) => ({ ...r })),
			notes: d.prepare('SELECT body FROM note ORDER BY created_at').all().map((r) => r.body),
			log: Number(Object.values(d.prepare('SELECT count(*) FROM activation_log').get())[0]),
			integrity: String(Object.values(d.prepare('PRAGMA integrity_check').get())[0]),
			journal: String(Object.values(d.prepare('PRAGMA journal_mode').get())[0]),
		};
	} finally { d.close(); }
}
/** SQLite header bytes 18/19: 1 = rollback journal, 2 = WAL. */
export function fileFormat(path) {
	const fd = openSync(path, 'r');
	try { const b = Buffer.alloc(100); readSync(fd, b, 0, 100, 0); return { write: b[18], read: b[19], magic: b.subarray(0, 15).toString('latin1') }; } finally { closeSync(fd); }
}

// ---- files -------------------------------------------------------------------------------------------------------
export function sparse(path, size) { const fd = openSync(path, 'w'); try { ftruncateSync(fd, size); } finally { closeSync(fd); } }
export function randomFile(path, size) {
	const fd = openSync(path, 'w');
	const h = createHash('sha256');
	try { for (let off = 0; off < size; ) { const n = Math.min(8 * MiB, size - off); const b = randomBytes(n); h.update(b); writeSync(fd, b, 0, n, off); off += n; } } finally { closeSync(fd); }
	return h.digest('hex');
}
const zeroDigests = new Map();
export function zeroSha(size) {
	if (zeroDigests.has(size)) return zeroDigests.get(size);
	const h = createHash('sha256'); const z = Buffer.alloc(8 * MiB);
	for (let off = 0; off < size; off += z.length) h.update(off + z.length <= size ? z : z.subarray(0, size - off));
	const d = h.digest('hex'); zeroDigests.set(size, d); return d;
}
/** Overwrite `bytes` at `offset` in place (same inode). Returns the bytes that were there. */
export function patchInPlace(path, offset, bytes) {
	const fd = openSync(path, 'r+');
	try { const old = Buffer.alloc(bytes.length); readSync(fd, old, 0, bytes.length, offset); writeSync(fd, bytes, 0, bytes.length, offset); return old; } finally { closeSync(fd); }
}
export function procIo(pid) {
	try { return Object.fromEntries(readFileSync(`/proc/${pid}/io`, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.split(': '); return [k, Number(v)]; })); } catch (e) { return { error: String(e.code ?? e) }; }
}
export const fdCount = (pid) => { try { return readdirSync(`/proc/${pid}/fd`).length; } catch { return null; } };
export const dirList = (p) => { try { return readdirSync(p); } catch (e) { return e.code === 'ENOENT' ? [] : [`<${e.code}>`]; } };
export const exists = existsSync;
export const size = (p) => { try { return statSync(p).size; } catch { return null; } };
export function compileShim(src, out) {
	const cc = ['cc', 'gcc', 'clang'].find((c) => spawnSync('bash', ['-c', `command -v ${c}`]).status === 0);
	if (!cc) return { ok: false, reason: 'no C compiler (cc, gcc, clang) on PATH' };
	const r = spawnSync(cc, ['-shared', '-fPIC', '-O2', '-o', out, src, '-ldl'], { encoding: 'utf8' });
	return r.status === 0 ? { ok: true, cc, so: out } : { ok: false, reason: `${cc} failed: ${r.stderr.slice(0, 400)}` };
}
