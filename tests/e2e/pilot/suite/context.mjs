// Run context of the browser suite: ports, one temp root, the app servers under test, the helper sites (another
// localhost app, a cross-site page, a PDFium control), read-only store access, and the network ledger (canary hits
// and every request the browser's targets made), with labelled positive-control windows.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { client, vpath } from '../lib/client.mjs';
import { startServer } from '../lib/server.mjs';
import { rawRequest } from './bytes.mjs';

/** App/originals servers use 43000-43298 only; the canary is 43299 (set before lib/cdp.mjs is imported). */
export const PORTS = Object.freeze({ A: 43000, A_ORIG: 43001, B: 43010, B_ORIG: 43011, OTHER_APP: 43290, XSITE: 43291, PDFIUM: 43292, CANARY: 43299 });
export const ORIGINALS_HOSTNAME = 'clearcase-originals.localhost';

/** One app server under test (its own ports and data directory), restartable on the same data directory. */
export function appServer({ name, root, buildDir, port, origPort, dir }) {
	const a = {
		name, port, origPort, dataDir: join(dir, `data-${name}`), logFile: join(dir, `server-${name}.log`),
		origin: `http://127.0.0.1:${port}`, origHost: `${ORIGINALS_HOSTNAME}:${origPort}`, orig: `http://${ORIGINALS_HOSTNAME}:${origPort}`,
		c: client(port), srv: null, starts: [],
		async start() {
			a.srv = await startServer({ root, port, origPort, dataDir: a.dataDir, buildDir, logFile: a.logFile });
			a.starts.push({ pid: a.srv.pid, readyMs: Math.round(a.srv.readyMs), build: a.srv.health?.instance?.build ?? null });
			return a.srv;
		},
		async stop() { const s = a.srv; a.srv = null; return s ? s.stop() : null; },
		v: (rv) => `${a.origin}${vpath(rv)}`,
		/** GET on the originals listener with its exact Host (Node's fetch cannot resolve *.localhost offline). */
		o: (path, headers = {}) => rawRequest(origPort, path, { host: a.origHost, ...headers }),
		raw: (path, headers = {}, method = 'GET', body = null) => rawRequest(port, path, { host: `127.0.0.1:${port}`, ...headers }, method, body),
		/** Read-only queries on the store files while the server runs (WAL results, rollback-journal work). */
		q(file, sql, ...args) {
			const d = new DatabaseSync(join(a.dataDir, file), { readOnly: true });
			try { d.exec('PRAGMA busy_timeout=5000'); return d.prepare(sql).all(...args).map((r) => ({ ...r })); } finally { d.close(); }
		},
		results: (sql, ...args) => a.q('results.sqlite', sql, ...args),
		work: (sql, ...args) => a.q('work.sqlite', sql, ...args),
	};
	return a;
}

/** Helper sites on loopback: another localhost app that sets cookies, a blank cross-site page, a PDFium control. */
export function helperSites(pdfiumBytes) {
	const html = (title, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
	const servers = [
		createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['other_app_session=1; Path=/', 'other_app_domain=1; Domain=localhost; Path=/'] });
			res.end(html('another local app', `<p>cookie header seen: ${String(req.headers.cookie ?? '').replace(/[<>&]/g, '')}</p>`));
		}).listen(PORTS.OTHER_APP, '127.0.0.1'),
		createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(html('another site'));
		}).listen(PORTS.XSITE, '127.0.0.1'),
		// The prototype's PDFium control: raw PDF bytes inline, so Chromium's own PDF viewer (which runs PDF JavaScript) gets them.
		createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline', 'content-length': pdfiumBytes.byteLength, 'cache-control': 'no-store' });
			res.end(Buffer.from(pdfiumBytes));
		}).listen(PORTS.PDFIUM, '127.0.0.1'),
	];
	return {
		otherApp: `http://localhost:${PORTS.OTHER_APP}`, xsite: `http://127.0.0.1:${PORTS.XSITE}`, pdfium: `http://127.0.0.1:${PORTS.PDFIUM}`,
		close: () => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
	};
}

/**
 * Chrome's own background services (time, component updater, GCM check-in) reach the canary through the resolver map
 * even with the harness flags. Such a hit is classified as browser background ONLY when it goes to a Google service
 * host, carries no Origin/Referer and is not one of the suite's beacon paths; every other hit is real.
 */
const BACKGROUND_HOST = /(^|\.)(google\.com|gvt1\.com|googleapis\.com|gstatic\.com)$/i;
export const isBackground = (h) => BACKGROUND_HOST.test(h.host?.replace(/:\d+$/, '') ?? h.sni ?? '') && !h.origin && !h.referer && !/(exec|img|pdf|narr|x\?p=)/.test(h.path ?? '');

/** Network ledger over the whole run. Controls are labelled time windows; hits inside one belong to that control. */
export function ledger(b, canary) {
	const controls = [];
	const originalsResponses = [];
	const cspConsole = [];
	b.on((m) => {
		if (m.method === 'Network.responseReceived') {
			const r = m.params.response;
			try {
				const u = new URL(r.url);
				if (u.hostname === ORIGINALS_HOSTNAME) originalsResponses.push({ at: Date.now(), url: r.url, status: r.status, type: m.params.type, headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v])) });
			} catch { /* data:, about: */ }
		}
	});
	const inControl = (at) => controls.find((c) => at >= c.from && at <= (c.to ?? Infinity));
	const allowedHost = (u) => (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === ORIGINALS_HOSTNAME) && Number(u.port) >= 43000 && Number(u.port) <= 43298;
	return {
		controls, originalsResponses, cspConsole,
		async control(label, fn) {
			const c = { label, from: Date.now(), to: null };
			controls.push(c);
			try { return await fn(); } finally { c.to = Date.now() + 300; }
		},
		/** Canary hits and off-origin target requests since `t0`, split into real, background and control. */
		since(t0 = 0) {
			const hits = canary.hits.filter((h) => h.at >= t0);
			const reqs = b.events.requests.filter((r) => r.at >= t0).filter((r) => { try { const u = new URL(r.url); return /^(https?|wss?):$/.test(u.protocol) && !allowedHost(u); } catch { return false; } });
			const fmt = (h) => `${h.kind} ${h.host ?? h.sni ?? ''}${h.path ?? ''}`.slice(0, 160);
			return {
				realHits: hits.filter((h) => !inControl(h.at) && !isBackground(h)).map(fmt),
				backgroundHits: hits.filter((h) => !inControl(h.at) && isBackground(h)).map(fmt),
				controlHits: hits.filter((h) => inControl(h.at)).map((h) => `${inControl(h.at).label}: ${fmt(h)}`),
				offOriginRequests: reqs.filter((r) => !inControl(r.at)).map((r) => `${r.method} ${r.url.slice(0, 120)} from ${r.ttype}:${(r.target ?? '').slice(0, 80)}`),
				controlRequests: reqs.filter((r) => inControl(r.at)).map((r) => `${inControl(r.at).label}: ${r.url.slice(0, 120)}`),
			};
		},
	};
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export { vpath };
