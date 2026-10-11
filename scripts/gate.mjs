#!/usr/bin/env bun
// `bun run --bun gate`: every check in order, stopping at the first failure.
//
// build (the e2e and parity steps need a build stamped with HEAD), check, test, test:e2e, parity --all
// --strict-register, verify:pilot:v5. Prints at most 30 lines: the head and tree state, one line per step
// (PASS/FAIL/SKIP and seconds), the tail of the first failure's log, and `GATE PASS <sha>` or
// `GATE FAIL <step> <sha>`. Full logs go to .local/gate/<step>.log. Exit 0 only when every step passed.
// Browser steps take a slot through $CLEARCASE_BROWSER_LOCK (a command that runs its arguments) when it is set.
// The v5 steps need the ignored locator .local/v5-verification.json and the case folder it names; a missing
// one fails the step, it is never skipped.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const LOCATOR = join('.local', 'v5-verification.json');
const TAIL_LINES = 14;
const MAX_WIDTH = 160;

const bun = (...args) => [process.execPath, 'run', '--bun', ...args];

/** The v5 locator and the case folder it names must exist. Returns the problem, or null. */
export function v5Prerequisite(repo = REPO) {
	const file = join(repo, LOCATOR);
	if (!existsSync(file)) return `missing prerequisite: ${LOCATOR} (the ignored v5 fixture locator)`;
	try {
		const { caseFolder } = JSON.parse(readFileSync(file, 'utf8'));
		if (typeof caseFolder !== 'string' || !existsSync(resolve(repo, caseFolder))) return `missing prerequisite: the v5 case folder named by ${LOCATOR} (${caseFolder})`;
	} catch (e) {
		return `unreadable prerequisite: ${LOCATOR}: ${e.message}`;
	}
	return null;
}

/** The gate's steps. `browser` steps take a lock slot; `needs` returns a problem string or null. */
export const STEPS = [
	{ name: 'build', cmd: bun('build') },
	{ name: 'check', cmd: bun('check') },
	{ name: 'test', cmd: bun('test', '--maxWorkers=2') },
	{ name: 'test:e2e', cmd: bun('test:e2e'), browser: true },
	{ name: 'parity', cmd: bun('parity', '--', '--all', '--strict-register', '--fixture-config', LOCATOR, '--out', join('.local', 'gate', 'parity-out')), browser: true, needs: v5Prerequisite },
	{ name: 'verify:pilot:v5', cmd: bun('verify:pilot:v5'), browser: true, needs: v5Prerequisite },
];

const logName = (step) => `${step.name.replace(/[^\w.-]/g, '-')}.log`;
const clip = (s) => (s.length > MAX_WIDTH ? `${s.slice(0, MAX_WIDTH - 1)}…` : s);

/** Runs `cmd` with stdout and stderr appended to `logFile`; returns the exit code. */
function exec(cmd, logFile, cwd) {
	const fd = openSync(logFile, 'a');
	try {
		const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', fd, fd], env: process.env });
		return r.status ?? 1;
	} finally {
		closeSync(fd);
	}
}

/**
 * Runs `steps` in order and stops at the first failure. Returns `{ pass, failed, lines }`; `lines` is the whole
 * summary. `head` is `{ sha, dirty }`. `exec`, `now` and `lock` are injectable so a test needs no browser.
 */
export function runGate(steps, { repo = REPO, head, lock = process.env.CLEARCASE_BROWSER_LOCK, run = exec, now = Date.now } = {}) {
	const logDir = join(repo, '.local', 'gate');
	mkdirSync(logDir, { recursive: true });
	const lines = [`gate ${head.sha} ${head.dirty ? 'DIRTY tree (not evidence)' : 'clean tree'}`];
	let failed = null;
	let tail = [];
	for (const step of steps) {
		if (failed) {
			lines.push(`SKIP ${step.name}`);
			continue;
		}
		const logFile = join(logDir, logName(step));
		writeFileSync(logFile, '');
		const start = now();
		const problem = step.needs?.(repo) ?? null;
		let code = 1;
		if (problem) writeFileSync(logFile, `${problem}\n`);
		else code = run(lock && step.browser ? [lock, ...step.cmd] : step.cmd, logFile, repo);
		const seconds = Math.round((now() - start) / 1000);
		lines.push(`${code === 0 && !problem ? 'PASS' : 'FAIL'} ${step.name} ${seconds}s`);
		if (code !== 0 || problem) {
			failed = step.name;
			tail = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim() !== '').slice(-TAIL_LINES).map(clip);
		}
	}
	if (failed) lines.push(...tail, `see ${join('.local', 'gate', logName(steps.find((s) => s.name === failed)))}`);
	lines.push(failed ? `GATE FAIL ${failed} ${head.sha}` : `GATE PASS ${head.sha}`);
	return { pass: !failed, failed, lines };
}

const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();

if (import.meta.main) {
	const head = { sha: git('rev-parse', '--short=12', 'HEAD'), dirty: git('status', '--porcelain') !== '' };
	const { pass, lines } = runGate(STEPS, { head });
	console.log(lines.join('\n'));
	process.exit(pass ? 0 : 1);
}
