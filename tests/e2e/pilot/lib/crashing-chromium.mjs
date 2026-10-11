// A stand-in for Chromium in the fail-fast regressions (lib/lifecycle.test.ts): a runner launches it through
// CLEARCASE_CHROMIUM (a shell script that runs this file with Bun) with Chromium's arguments. By its environment it
//   CRASH_AT=launch   dies (SIGKILL) before it prints a DevTools endpoint, as a crash at launch does; with
//                     CRASH_ONCE=<file> only while <file> does not exist (it creates it), so the retry comes up
//   CRASH_ON_PAGE=n   runs the real browser and kills it (SIGKILL) when its n-th page target is created (the first is
//                     the launch's about:blank), seen through a second DevTools client: a crash in the middle of a step
// and otherwise runs the real browser (REAL_CHROMIUM) unchanged. It exits as the browser did, so the runner sees
// "Chromium exited (signal SIGKILL)"; the real browser dies with it (setpriv --pdeathsig).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const env = process.env;
if (env.CRASH_AT === 'launch' && !(env.CRASH_ONCE && existsSync(env.CRASH_ONCE))) {
	if (env.CRASH_ONCE) writeFileSync(env.CRASH_ONCE, '');
	process.kill(process.pid, 'SIGKILL');
}
const real = spawn('setpriv', ['--pdeathsig', 'KILL', '--', env.REAL_CHROMIUM, ...process.argv.slice(2)], { stdio: ['ignore', 'ignore', 'pipe'] });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => real.kill(sig));
real.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
let buf = '', watching = false;
real.stderr.on('data', (d) => {
	process.stderr.write(d);
	buf += d;
	const m = /DevTools listening on (ws:\S+)/.exec(buf);
	if (m && env.CRASH_ON_PAGE && !watching) { watching = true; watch(m[1], +env.CRASH_ON_PAGE); }
});

function watch(url, n) {
	const ws = new WebSocket(url);
	let pages = 0;
	ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
	ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && ++pages === n) real.kill('SIGKILL'); };
}
