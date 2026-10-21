#!/usr/bin/env bun
// The host browser lock's queue as gates meet it (GRS-154), on temporary lock files so no real browser job is touched:
// two gates admitted through the lock scripts/browser-lock.mjs resolves for this checkout hold both slots, a third gate
// and an `--exclusive` evidence job wait, and the exclusive job runs with no other holder.
//   bun tests/gate/browser-queue.mjs [--out FILE]
// Not a Vitest file: it needs the workspace's orch-bin/browser-lock, which a CI checkout lacks. Exit 2 when this
// checkout's admission is none or refused, 1 when an invariant fails, 0 when all hold.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describeAdmission, gitEnv, resolveBrowserLock } from '../../scripts/browser-lock.mjs';
import { readHead, runGate } from '../../scripts/gate.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
/** A browser job: records its start and the slot it holds, waits for <dir>/release-<name>, records its end. */
const HOLD = 'echo "$(date +%s%N) start $2 ${CLEARCASE_BROWSER_SLOT:-}" >> "$1/events"; while [ ! -e "$1/release-$2" ]; do sleep 0.05; done; echo "$(date +%s%N) end $2" >> "$1/events"';

if (argv[0] === '--job') {
	const [, name, dir] = argv;
	const repo = join(dir, name);
	const r = await runGate([{ name: 'browser', cmd: ['sh', '-c', HOLD, 'job', dir, name], browser: true }], { repo, head: readHead(undefined, repo).head, admission: resolveBrowserLock({ repo: REPO }) });
	writeFileSync(join(dir, `${name}.gate`), `${r.lines.join('\n')}\n`);
	process.exit(r.pass ? 0 : 1);
}

const admission = resolveBrowserLock({ repo: REPO });
if (admission.problem || !admission.lock) {
	console.error(`browser-queue: needs a browser lock, and this checkout has ${admission.problem ?? 'none'}`);
	process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'gate-queue-'));
const locks = [join(dir, 'a.lock'), join(dir, 'b.lock')];
const env = { ...process.env, CLEARCASE_BROWSER_LOCKS: locks.join(' '), CLEARCASE_BROWSER_POLL: '1', CLEARCASE_BROWSER_SLOT_WAIT: '120', CLEARCASE_BROWSER_MIN_MB: '0' };
delete env.CLEARCASE_BROWSER_SLOT;
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.name=queue-probe', '-c', 'user.email=queue-probe@example.invalid', ...a], { encoding: 'utf8', env: gitEnv() });
const exits = {};
const children = [];
function track(name, child) {
	children.push(child);
	exits[name] = new Promise((res) => child.on('exit', (code, signal) => res(code ?? signal)));
}
function startGate(name) {
	const repo = join(dir, name);
	mkdirSync(repo);
	git(repo, 'init', '-q');
	writeFileSync(join(repo, '.gitignore'), '.local/\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'synthetic');
	track(name, spawn(process.execPath, [import.meta.filename, '--job', name, dir], { env, stdio: 'ignore' }));
}
const events = () => (existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8').trim().split('\n').map((l) => { const [t, kind, name, ...slot] = l.split(' '); return { us: Number(BigInt(t) / 1000n), kind, name, slot: slot.join(' ') }; }) : []);
const started = (name) => events().some((e) => e.kind === 'start' && e.name === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (pred()) return true;
	return pred();
}
const release = (name) => writeFileSync(join(dir, `release-${name}`), '');
const checks = [];
const check = (what, ok, got) => { checks.push({ what, status: ok ? 'PASS' : 'FAIL', got }); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok ? '' : `: ${got}`}`); };
const NAMES = ['gate1', 'gate2', 'gate3', 'exclusive'];

console.log(describeAdmission(admission));
console.log(`temporary slots ${locks.join(' ')}`);
try {
	startGate('gate1');
	startGate('gate2');
	check('two admitted gates start and hold one slot each', await until(() => started('gate1') && started('gate2'), 15_000), events());
	const held = events().filter((e) => e.kind === 'start').map((e) => e.slot).sort();
	check('the two gates hold slot A and slot B', JSON.stringify(held) === JSON.stringify(locks), held);
	startGate('gate3');
	track('exclusive', spawn(admission.lock, ['--exclusive', 'sh', '-c', HOLD, 'job', dir, 'exclusive'], { env, stdio: 'ignore' }));
	await sleep(3500);
	check('a third gate waits while both slots are held', !started('gate3'), events());
	check('an exclusive job waits while both slots are held', !started('exclusive'), events());
	release('gate1');
	await sleep(3500);
	check('the exclusive job still waits while slot B is held', !started('exclusive'), events());
	release('gate2');
	const done = () => NAMES.every((n) => events().some((e) => e.kind === 'end' && e.name === n));
	for (const end = Date.now() + 60_000; !done() && Date.now() < end; await sleep(1000)) for (const n of NAMES) if (started(n)) release(n);
	check('every job ran and ended within 60 s of the slots freeing', done(), events());
} finally {
	for (const n of NAMES) release(n);
	await Promise.race([Promise.all(Object.values(exits)), sleep(10_000)]);
	for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
}

const codes = Object.fromEntries(await Promise.all(Object.entries(exits).map(async ([n, p]) => [n, await p])));
check('every gate and the exclusive job exited 0', Object.values(codes).every((c) => c === 0), codes);
const gates = ['gate1', 'gate2', 'gate3'].map((n) => (existsSync(join(dir, `${n}.gate`)) ? readFileSync(join(dir, `${n}.gate`), 'utf8') : ''));
check('each gate named the resolved lock and passed', gates.every((g) => g.includes(describeAdmission(admission)) && /GATE PASS \w+\n$/.test(g)), gates);
const span = Object.fromEntries(NAMES.map((n) => [n, { start: events().find((e) => e.kind === 'start' && e.name === n)?.us, end: events().find((e) => e.kind === 'end' && e.name === n)?.us, slot: events().find((e) => e.kind === 'start' && e.name === n)?.slot }]));
const overlap = (a, b) => a.start < b.end && b.start < a.end;
check('gate1 and gate2 held their slots at the same time', overlap(span.gate1, span.gate2), span);
check('the third gate started only after a slot freed', span.gate3.start >= Math.min(span.gate1.end, span.gate2.end), span);
check('the exclusive job started only after both slots freed', span.exclusive.start >= Math.max(span.gate1.end, span.gate2.end), span);
check('the exclusive job held both slots and overlapped no other job', span.exclusive.slot === locks.join(' ') && ['gate1', 'gate2', 'gate3'].every((n) => !overlap(span.exclusive, span[n])), span);
let running = 0, peak = 0;
for (const e of events().sort((x, y) => x.us - y.us || (x.kind === 'end' ? -1 : 1))) peak = Math.max(peak, (running += e.kind === 'start' ? 1 : -1));
check('no more than two jobs ever ran at once', peak <= 2, peak);
check('the real host slots were never named', !locks.some((l) => ['/tmp/clearcase-browser.lock', '/tmp/clearcase-browser-2.lock'].includes(l)), locks);

const ok = checks.every((c) => c.status === 'PASS');
const out = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : null;
if (out) writeFileSync(out, `${JSON.stringify({ schema: 'clearcase-browser-queue/1', lock: admission, slots: locks, ok, checks, span }, null, 1)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`browser-queue: ${ok ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.status === 'PASS').length}/${checks.length})`);
process.exit(ok ? 0 : 1);
