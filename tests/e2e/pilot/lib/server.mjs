// Start and stop the production entry (bun scripts/pilot/start.ts) for one run: its own ports, data directory and
// log. Waits until /api/health answers from the spawned PID; every spawned server is killed on exit.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { sleep } from './cdp.mjs';

const pids = new Set();
process.on('exit', () => { for (const p of pids) try { process.kill(p, 'SIGKILL'); } catch {} });

export const portOpen = (port, host = '127.0.0.1') => new Promise((res) => {
	const s = net.connect({ port, host });
	s.once('connect', () => { s.destroy(); res(true); });
	s.once('error', (e) => res(e.code));
});

/** The Bun that runs servers: this process when it is Bun, else `bun` from PATH. */
export const BUN = process.versions.bun ? process.execPath : 'bun';
export const bunIdentity = () => ({ path: BUN, version: spawnSync(BUN, ['--version'], { encoding: 'utf8' }).stdout.trim() });

export async function startServer({ root, port, origPort, dataDir, buildDir, logFile, env = {}, timeoutMs = 30000 }) {
	const log = createWriteStream(logFile, { flags: 'a' });
	const args = [join(root, 'scripts', 'pilot', 'start.ts')];
	const childEnv = {
		PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), ORIGINALS_PORT: String(origPort), CLEARCASE_DATA_DIR: dataDir,
		...(buildDir ? { BUILD_DIR: buildDir } : {}),
		...(process.env.CLEARCASE_OFFLINE ? { CLEARCASE_OFFLINE: process.env.CLEARCASE_OFFLINE } : {}),
		...env,
	};
	log.write(`\n# ${new Date().toISOString()} ${BUN} ${args.join(' ')} PORT=${port} ORIGINALS_PORT=${origPort} CLEARCASE_DATA_DIR=${dataDir}\n`);
	const t0 = performance.now();
	const proc = spawn(BUN, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
	pids.add(proc.pid);
	proc.stdout.pipe(log, { end: false });
	proc.stderr.pipe(log, { end: false });
	let exited = null;
	proc.on('exit', (code, sig) => { exited = { code, sig, at: performance.now() }; pids.delete(proc.pid); });
	let health = null;
	for (;;) {
		if (exited) throw Object.assign(new Error(`server exited during startup: ${JSON.stringify(exited)} (see ${logFile})`), { exited });
		if ((await portOpen(port)) === true && (await portOpen(origPort)) === true) {
			health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null);
			if (health?.instance?.pid === proc.pid) break;
		}
		if (performance.now() - t0 > timeoutMs) { proc.kill('SIGKILL'); throw new Error(`server did not start in ${timeoutMs} ms (see ${logFile})`); }
		await sleep(10);
	}
	const readyMs = performance.now() - t0;
	return {
		proc, pid: proc.pid, readyMs, health, port, origPort, dataDir,
		get exited() { return exited; },
		async stop(sig = 'SIGTERM', timeout = 8000) {
			const t = performance.now();
			if (!exited) proc.kill(sig);
			while (!exited && performance.now() - t < timeout) await sleep(10);
			const graceful = !!exited;
			if (!exited) { proc.kill('SIGKILL'); while (!exited) await sleep(10); }
			await sleep(30);
			return { graceful, exit: exited, ms: +(performance.now() - t).toFixed(1), appPort: await portOpen(port), origPort: await portOpen(origPort) };
		},
	};
}
