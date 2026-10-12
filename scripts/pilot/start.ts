#!/usr/bin/env bun
// Production entry of the local pilot, under Bun only. It never installs or builds: run
// `bun install --frozen-lockfile` and `bun run --bun build` first.
//   app       http://127.0.0.1:$PORT                              (bound to 127.0.0.1 only)
//   originals http://clearcase-originals.localhost:$ORIGINALS_PORT  (bound to 127.0.0.1; a site of its own)
// Env: PORT (41101), ORIGINALS_PORT (PORT+1), ORIGINALS_HOSTNAME, CLEARCASE_DATA_DIR
// (default ${XDG_DATA_HOME:-~/.local/share}/clearcase), CLEARCASE_KEEP_CANDIDATES (3), CLEARCASE_KEEP_BACKUPS (10),
// BUILD_DIR (./build). SIGTERM/SIGINT close both listeners, write a pending backup and checkpoint SQLite.
// The server records itself in .local/pilot/start-$PORT.pid; `bun run --bun start --stop` (same PORT) stops that server
// only, so nobody needs `pkill -f scripts/pilot/start.ts`, which also matches other worktrees' servers.
//
// The listener wraps adapter-node's handler with the exact Host check, so static build assets are covered too
// (adapter-node serves them before hooks.server.ts runs; prototype finding W-HOST-03).
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDataDir } from '../../src/lib/local-case/config.server.ts';
import { removePidFile, stopPidFile, writePidFile } from '../pidfile.ts';

const die = (msg: string): never => { console.error(`start: ${msg}`); process.exit(1); };
const MIN_BUN = '1.4.2';
const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return true; };
if (!process.versions.bun) die('ClearCase runs under Bun: use `bun run --bun start`');
if (!newer(process.versions.bun!, MIN_BUN)) die(`Bun >= ${MIN_BUN} is required (this is ${process.versions.bun})`);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pidFile = (p: string | undefined) => join(root, '.local', 'pilot', `start-${p ?? 41101}.pid`);
if (process.argv.includes('--stop')) {
	console.log(`start --stop: ${await stopPidFile(pidFile(process.env.PORT))}`);
	process.exit(0);
}
const build = resolve(process.env.BUILD_DIR ?? join(root, 'build'));
for (const f of ['handler.js', 'pdfjs/manifest.json', 'clearcase-build.json'])
	if (!existsSync(join(build, f))) die(`${join(build, f)} is missing. Build first: bun install --frozen-lockfile && bun run --bun build`);

const port = Number(process.env.PORT ?? 41101);
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid PORT ${process.env.PORT}`);
process.env.HOST = '127.0.0.1';
process.env.PORT = String(port);
process.env.ORIGIN = `http://127.0.0.1:${port}`;
process.env.ORIGINALS_PORT ??= String(port + 1);
process.env.ORIGINALS_HOSTNAME ||= 'clearcase-originals.localhost';
process.env.CLEARCASE_DATA_DIR = resolveDataDir();
process.env.CLEARCASE_BUILD_DIR = build;
process.env.PDFJS_DIR = join(build, 'pdfjs');
const stamp = JSON.parse(readFileSync(join(build, 'clearcase-build.json'), 'utf8')) as { buildId: string; revision: string | null; dirty: boolean };
console.error(`ClearCase pilot: app ${process.env.ORIGIN}, originals http://${process.env.ORIGINALS_HOSTNAME}:${process.env.ORIGINALS_PORT}, data ${process.env.CLEARCASE_DATA_DIR}, build ${stamp.buildId} (${stamp.revision?.slice(0, 12) ?? 'unknown'}${stamp.dirty ? ', dirty' : ''}), bun ${process.versions.bun}`);

// Importing the handler runs SvelteKit's server init, i.e. hooks.server.ts init: lock, originals listener, startup.
const { handler } = (await import(pathToFileURL(join(build, 'handler.js')).href)) as { handler: (req: unknown, res: unknown) => void };
const appHost = `127.0.0.1:${port}`;
const server = createServer((req, res) => {
	if (req.headers.host !== appHost) {
		res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' });
		return void res.end('misdirected request: unknown Host');
	}
	handler(req, res);
});
server.on('error', (e: NodeJS.ErrnoException) => { console.error(`FATAL: the app listener cannot bind ${appHost} (${e.code ?? e.message}). Exiting.`); process.emit('sveltekit:shutdown' as never, 'bind-error' as never); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
	writePidFile(pidFile(String(port)));
	console.log(`app listening on ${appHost}`);
});
process.on('exit', () => removePidFile(pidFile(String(port))));

let stopping = false;
const stop = (reason: string) => {
	if (stopping) return;
	stopping = true;
	server.close(() => {
		process.emit('sveltekit:shutdown' as never, reason as never);
		process.exit(0);
	});
	server.closeIdleConnections();
	setTimeout(() => server.closeAllConnections(), 2000).unref();
	setTimeout(() => { console.error('shutdown timed out'); process.exit(1); }, 8000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
