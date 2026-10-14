// A read-only, password-protected front door for a tour of the running app, meant to sit behind a Cloudflare quick
// tunnel: `TOUR_PASSWORD=... bun scripts/demo/tour-proxy.ts`, then
// `cloudflared tunnel --url http://127.0.0.1:41190 --protocol http2`. Only GET and HEAD pass; the import page, the
// folder browser, the import progress feed, recovery and the system views are refused, so a visitor can read every
// case view but cannot see the machine's folders or change anything. The app itself still refuses every form POST
// from a foreign origin, so this is a second fence, not the only one. Env: TOUR_PORT (41190), UPSTREAM_PORT (41101),
// TOUR_USER (tour), TOUR_PASSWORD (required).
import { createServer, request } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.TOUR_PORT ?? 41190);
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? 41101);
const user = process.env.TOUR_USER ?? 'tour';
const password = process.env.TOUR_PASSWORD;
if (!password) { console.error('TOUR_PASSWORD is required'); process.exit(2); }

const BLOCKED = [/^\/import(\/|$|\?)/, /^\/api\/browse/, /^\/api\/import-progress/, /^\/recovery/, /^\/v\/[^/]+\/system\//];
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authorised = (header: string | undefined) => {
	if (!header?.startsWith('Basic ')) return false;
	const [u, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
	return same(u ?? '', user) && same(rest.join(':'), password);
};
const refuse = (res: import('node:http').ServerResponse, status: number, text: string, extra: Record<string, string> = {}) =>
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }).end(text);

createServer((req, res) => {
	if (!authorised(req.headers.authorization)) return refuse(res, 401, 'ClearCase tour: sign in', { 'www-authenticate': 'Basic realm="ClearCase tour", charset="UTF-8"' });
	if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'This is a read-only tour: nothing can be changed here.', { allow: 'GET, HEAD' });
	const url = req.url ?? '/';
	if (BLOCKED.some((re) => re.test(url))) return refuse(res, 403, 'This page is not part of the tour.');
	const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
	delete headers.authorization; delete headers.connection; delete headers['content-length'];
	const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: url, headers }, (r) => {
		res.writeHead(r.statusCode ?? 502, r.headers);
		r.pipe(res);
	});
	up.on('error', (e) => refuse(res, 502, `The app is not answering (${e.message}).`));
	req.pipe(up);
}).listen(port, '127.0.0.1', () => console.log(`tour proxy on http://127.0.0.1:${port} -> http://127.0.0.1:${upstreamPort} (user ${user})`));
