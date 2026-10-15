import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { authorised, canonicalPath, refused } from './tour-policy.ts';

const port = Number(process.env.TOUR_PORT ?? 41190);
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? 41101);
const user = process.env.TOUR_USER ?? 'tour';
const password = process.env.TOUR_PASSWORD;
if (!password) { console.error('TOUR_PASSWORD is required'); process.exit(2); }

const refuse = (res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}) =>
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }).end(text);

const serve = (req: IncomingMessage, res: ServerResponse) => {
	if (!authorised(req.headers.authorization, user, password)) return refuse(res, 401, 'ClearCase tour: sign in', { 'www-authenticate': 'Basic realm="ClearCase tour", charset="UTF-8"' });
	if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'This is a read-only tour: nothing can be changed here.', { allow: 'GET, HEAD' });
	const url = req.url ?? '/';
	const canonical = canonicalPath(url);
	if (canonical === null) return refuse(res, 400, 'That address cannot be read.');
	if (refused(canonical)) return refuse(res, 403, 'This page is not part of the tour.');
	const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
	delete headers.authorization; delete headers.connection; delete headers['content-length'];
	const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: url, headers }, (r) => {
		res.writeHead(r.statusCode ?? 502, r.headers);
		r.pipe(res);
	});
	up.on('error', (e) => refuse(res, 502, `The app is not answering (${e.message}).`));
	req.pipe(up);
};

const server = createServer((req, res) => {
	try { serve(req, res); } catch (e) {
		console.error(`tour proxy: ${(e as Error).stack ?? e}`);
		if (!res.headersSent) refuse(res, 500, 'The tour could not answer that request.');
		else res.destroy();
	}
});
server.listen(port, '127.0.0.1', () => {
	const a = server.address();
	const bound = typeof a === 'object' && a ? a.port : port;
	console.log(`tour proxy on http://127.0.0.1:${bound} -> http://127.0.0.1:${upstreamPort} (user ${user})`);
});
