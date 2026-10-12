// A stand-in gate leader for gate.test.ts, run as `bun admit-child.mjs <json>`. It tries gate.mjs's real admission
// against `pidFile` and prints ADMITTED or the refusal; with `mode: 'stop'` it runs `gate --stop`'s stop instead and
// prints its outcome. `startAt` (ms) spins until that moment, so several children try at once. At each label in `pauses`
// (pidfile.ts's `steps`, first time only) it creates <ctl>/<name>@<label> and waits for <ctl>/<name>@<label>.go, so a
// test can order its steps against another child's. An admitted child holds its claim until <ctl>/<name>.release
// exists or `hold` ms pass, then releases it as the gate does on exit. With `grandchild`, it first starts a `sleep` in
// its process group, which outlives it when it is SIGKILLed.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { admit } from '../../scripts/gate.mjs';
import { removePidFile, steps, stopPidFile } from '../../scripts/pidfile.ts';

const o = { pauses: [], hold: 20_000, ...JSON.parse(process.argv[2]) };
const flag = (suffix) => join(o.ctl ?? '.', `${o.name}${suffix}`);
const wait = new Int32Array(new SharedArrayBuffer(4));
const seen = new Set();
steps.at = (label) => {
	if (!o.pauses.includes(label) || seen.has(label)) return;
	seen.add(label);
	writeFileSync(flag(`@${label}`), '');
	for (const end = Date.now() + 20_000; !existsSync(flag(`@${label}.go`)) && Date.now() < end; ) Atomics.wait(wait, 0, 0, 5);
};
if (o.grandchild) spawn('sleep', ['60'], { stdio: 'ignore' });
while (Date.now() < (o.startAt ?? 0));
if (o.mode === 'stop') {
	const { message } = await stopPidFile(o.pidFile, { group: true, graceMs: 2000, marker: { name: 'CLEARCASE_GATE_LEADER', value: resolve(import.meta.dirname, '../..') } });
	console.log(`stop: ${message}`);
} else {
	const refused = admit(o.pidFile);
	console.log(refused ?? 'ADMITTED');
	if (!refused) {
		for (const end = Date.now() + o.hold; !existsSync(flag('.release')) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
		removePidFile(o.pidFile);
	}
}
