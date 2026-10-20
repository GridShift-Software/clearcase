// Drives `serve` (scripts/pilot/hosted.ts) over a stand-in for Wrangler, in a process of its own so a test can
// signal it: bun hosted-serve-driver.ts DIR READY_MS. DIR holds the stand-in (wrangler-stub.mjs), which the test writes;
// the pid file, the state file and the log go there too.
import path from 'node:path';
import { serve } from '../../../scripts/pilot/hosted.ts';

const [dir, readyMs] = process.argv.slice(2);
await serve(
	{ command: process.execPath, args: [path.join(dir, 'wrangler-stub.mjs')], env: { PATH: '/usr/bin:/bin', DIR: dir }, cwd: dir, logFile: path.join(dir, 'wrangler.log'), readyMs: Number(readyMs), pidFile: path.join(dir, 'start.pid'), stateFile: path.join(dir, 'server.json') },
	async () => {},
	() => ({ schema: 'clearcase.hosted-server/1', pid: process.pid, port: 0, base: '', revision: '', profile: 'hosted-gate', artifact: '', runDir: '', persist: '', runId: 'driver', fixtureSha256: null, node: '', startedAt: '' }),
);
console.log('driver: serving');
