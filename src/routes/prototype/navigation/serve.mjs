// PROTOTYPE (GRS-89), throwaway: serves prototype.html at /prototype/navigation on loopback. Not part of the app or
// its build; SvelteKit ignores this folder because it has no + files.
//
//   bun src/routes/prototype/navigation/serve.mjs          start on 127.0.0.1:44189 (PORT overrides)
//   bun src/routes/prototype/navigation/serve.mjs --stop   stop the server this script started on that port
//
// The page is read from disk on every request, so an edit shows on reload. --stop signals only the pid recorded in
// .local/prototype-navigation-<port>.pid, and only when that process is still running this script.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const page = fileURLToPath(new URL('./prototype.html', import.meta.url));
const self = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const port = Number(process.env.PORT ?? 44189);
const pidFile = `${root}.local/prototype-navigation-${port}.pid`;

if (process.argv.includes('--stop')) {
	if (!existsSync(pidFile)) {
		console.log(`no prototype server recorded for port ${port}`);
		process.exit(0);
	}
	const pid = Number(readFileSync(pidFile, 'utf8').trim());
	let cmd = '';
	try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* not running */ }
	if (cmd.includes(self)) {
		process.kill(pid, 'SIGTERM');
		console.log(`stopped prototype server pid ${pid} on port ${port}`);
	} else console.log(`pid ${pid} is no longer this prototype server; removing the stale record`);
	rmSync(pidFile, { force: true });
	process.exit(0);
}

// Inline script and style only; nothing may load from anywhere, including this server.
const headers = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const server = Bun.serve({
	hostname: '127.0.0.1',
	port,
	fetch(req) {
		const { pathname, search } = new URL(req.url);
		if (pathname === '/') return Response.redirect(`/prototype/navigation${search}`, 302);
		if (pathname === '/prototype/navigation') return new Response(readFileSync(page), { headers });
		return new Response('not found: the prototype is at /prototype/navigation?variant=A|B\n', { status: 404 });
	},
});
writeFileSync(pidFile, `${process.pid}\n`);
const stop = () => { rmSync(pidFile, { force: true }); server.stop(true); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log(`GRS-89 navigation prototype: http://127.0.0.1:${server.port}/prototype/navigation?variant=A (pid ${process.pid}; stop with --stop)`);
