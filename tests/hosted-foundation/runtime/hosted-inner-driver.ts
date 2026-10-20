// A stand-in for `bun run --bun start:hosted` and `start:hosted --stop` in a scratch repo (hosted-inner-ownership.test.ts):
// the real `serve` (scripts/pilot/hosted.ts) and the real pid-file stop (scripts/pidfile.ts) over a stand-in for Wrangler.
//   bun hosted-inner-driver.ts [--stop]    cwd is the scratch repo; env PORT, REV, STUB (the Wrangler stand-in's path)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { stopPidFile } from '../../../scripts/pidfile.ts';
import { serve } from '../../../scripts/pilot/hosted.ts';

const root = process.cwd(), port = Number(process.env.PORT), dir = path.join(root, '.local', 'hosted');
const pidFile = path.join(dir, `start-${port}.pid`), stateFile = path.join(dir, `server-${port}.json`);
mkdirSync(dir, { recursive: true });
try {
	if (process.argv.includes('--stop')) {
		const { ok, message } = await stopPidFile(pidFile, { graceMs: 10_000 });
		console.log(`start:hosted --stop: ${message}`);
		process.exitCode = ok ? 0 : 1;
	} else {
		await serve(
			{ command: process.execPath, args: [process.env.STUB!], env: { PATH: '/usr/bin:/bin', DIR: dir }, cwd: root, logFile: path.join(dir, `wrangler-${process.pid}.log`), readyMs: 120_000, pidFile, stateFile },
			async () => {},
			() => ({ schema: 'clearcase.hosted-server/1', pid: process.pid, port, base: `http://127.0.0.1:${port}`, revision: process.env.REV!, profile: 'hosted-gate', artifact: '', runDir: '.local/hosted/run-x', persist: '.local/hosted/run-x/persist', runId: 'driver', fixtureSha256: null, node: '', startedAt: new Date().toISOString() }),
		);
		console.log('driver: serving');
	}
} catch (e) {
	console.error(`hosted start: ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = e instanceof Error && e.constructor.name === 'Refusal' ? 2 : 1;
}
