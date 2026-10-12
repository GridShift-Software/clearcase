#!/usr/bin/env bun
// `bun run --bun gate`: every check in order, stopping at the first failure.
//
// build (the e2e and parity steps need a build stamped with HEAD), check, test, test:e2e, parity --all
// --strict-register, verify:pilot:v5. Prints at most 30 lines: the head and tree state, one line per step
// (PASS/FAIL/SKIP and seconds), the tail of the first failure's log, and `GATE PASS <sha>` or
// `GATE FAIL <step> <sha>`. Full logs go to .local/gate/<step>.log, with `:` in the step name replaced by `-`. Exit 0 only when every step passed.
// Browser steps take a slot through $CLEARCASE_BROWSER_LOCK (a command that runs its arguments) when it is set.
// Exit 0 is not evidence: test:e2e, parity and verify:pilot:v5 exit 0 for a reduced or stale-build run and record
// `evidence: false`. So the gate refuses to start when a variable that selects a reduced run is set (REDUCED_ENV), and
// after each of those steps it reads the summary the step wrote in this run (an old one is deleted first) and requires
// `evidence: true` for HEAD; a missing, unreadable, stale or `evidence: false` summary fails the step.
// The v5 steps need the ignored locator .local/v5-verification.json, the case folder it names, and an accepted
// resultsVersion that this revision's converter still produces. Every step's prerequisite is checked before the first
// step runs, so a missing or stale locator fails the gate in seconds, not after the build and the test suites; a
// failed prerequisite fails its step, it is never skipped.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEV_ENV } from '../tests/e2e/pilot/run.mjs';
import { convert as convertV5, loadConfig } from '../tests/e2e/pilot/v5/fixture.mjs';

const REPO = resolve(import.meta.dirname, '..');
const LOCATOR = join('.local', 'v5-verification.json');
const TAIL_LINES = 14;
const MAX_WIDTH = 160;

/** The variables that make a runner cover less than the gate, with what each does: test:e2e's knobs and parity's combo cap. */
export const REDUCED_ENV = { ...DEV_ENV, PARITY_MAX_COMBOS: 'compares only some chronology UI combinations' };

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

/**
 * The locator's accepted resultsVersion must be the one this revision's converter produces from the v5 sample: a
 * locator copied before a converter change (a view-content map change, say) otherwise fails parity only at its setup,
 * after the build and the test suites. Converts the sample (about 3 s) into .local/gate/v5-preflight and removes it.
 * Returns the problem, or null. `load` and `convert` are tests/e2e/pilot/v5/fixture.mjs's, injectable for tests.
 */
export async function v5Current(repo = REPO, { load = loadConfig, convert = convertV5 } = {}) {
	const file = join(repo, LOCATOR);
	let fx;
	try {
		fx = await load(file);
	} catch (e) {
		return `invalid prerequisite: ${e.message}`;
	}
	const out = join(repo, '.local', 'gate', 'v5-preflight');
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	try {
		const r = convert({ html: fx.cfg.mainHtml.path, caseFolder: fx.caseFolder, caseId: fx.caseId, out: join(out, 'pkg'), report: join(out, 'convert-report.json') });
		const manifest = join(out, 'pkg', 'manifest.json');
		if (r.exit !== 0 || !existsSync(manifest)) return `v5 conversion failed (exit ${r.exit}): ${r.stderr.trim().split('\n').at(-1) ?? ''}`;
		const expected = JSON.parse(readFileSync(manifest, 'utf8')).resultsVersion;
		const accepted = fx.accepted.resultsVersion;
		if (expected === accepted) return null;
		const field = fx.accepted === fx.acceptedBase ? 'accepted.resultsVersion' : 'acceptedViewContent.resultsVersion';
		return [
			`stale prerequisite: ${LOCATOR} accepts resultsVersion ${accepted}`,
			`but this revision converts the v5 sample to ${expected}.`,
			`Refresh: copy the coordinator's current locator to ${LOCATOR}. If this branch changes the converter output`,
			`on purpose, set ${field} to ${expected} instead and report the new value.`,
		].join('\n');
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

/** The v5 steps' prerequisite: the locator and its case folder exist, then the locator is current. */
const v5Ready = async (repo = REPO) => v5Prerequisite(repo) ?? (await v5Current(repo));

/**
 * The gate's steps. `browser` steps take a lock slot; `needs` returns (or resolves to) a problem string or null, and
 * runs once per distinct function, before the first step. `summary` names the
 * file the step must write, `{ dir, file, env }`: `dir` is under the repo and goes to the step in $env when `env` is
 * given (else the step's arguments carry it).
 */
export const STEPS = [
	{ name: 'build', cmd: bun('build') },
	{ name: 'check', cmd: bun('check') },
	{ name: 'test', cmd: bun('test', '--maxWorkers=2') },
	{ name: 'test:e2e', cmd: bun('test:e2e'), browser: true, summary: { dir: join('.local', 'gate', 'e2e-out'), file: 'summary.json', env: 'CLEARCASE_E2E_OUT' } },
	{ name: 'parity', cmd: bun('parity', '--', '--all', '--strict-register', '--fixture-config', LOCATOR, '--out', join('.local', 'gate', 'parity-out')), browser: true, needs: v5Ready, summary: { dir: join('.local', 'gate', 'parity-out'), file: 'scorecard.json' } },
	{ name: 'verify:pilot:v5', cmd: bun('verify:pilot:v5'), browser: true, needs: v5Ready, summary: { dir: join('.local', 'gate', 'v5-out'), file: 'lanes-v5.json', env: 'CLEARCASE_REPORT_DIR' } },
];

const logName = (step) => `${step.name.replace(/[^\w.-]/g, '-')}.log`;
const clip = (s) => (s.length > MAX_WIDTH ? `${s.slice(0, MAX_WIDTH - 1)}…` : s);

/** Runs `cmd` with stdout and stderr appended to `logFile` (and `env` added to the environment); returns the spawn result (`status`, `signal`, `error`). */
function exec(cmd, logFile, cwd, env = {}) {
	const fd = openSync(logFile, 'a');
	try {
		return spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
	} finally {
		closeSync(fd);
	}
}

/** Why a run did not exit 0, as a log line, or null when it did. A spawn error and a signal leave no output of their own. */
function failure(cmd, r) {
	if (r.error) return `gate: cannot run ${cmd[0]}: ${r.error.message}`;
	return r.signal ? `gate: killed by ${r.signal}` : null;
}

/** The reduced-run variables set in `env` (even empty, as the runners test), as problem lines. */
const reducedRun = (env) => Object.entries(REDUCED_ENV).filter(([k]) => env[k] !== undefined).map(([k, what]) => `${k} is set (${JSON.stringify(env[k])}): it ${what}, so the run would not be evidence; unset it`);

/** Why a finished step's summary is not evidence for `sha` (the head's short SHA), or null. */
function summaryProblem(step, file, sha) {
	const name = step.name;
	if (!existsSync(file)) return `${name}: no summary at ${file}: the step did not write one in this run`;
	let doc;
	try {
		doc = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		return `${name}: summary does not parse (${e.message}): ${file}`;
	}
	if (doc?.evidence !== true) return `${name}: summary says evidence is not true: ${doc?.evidenceNote ?? `no evidence field in ${file}`}`;
	if (doc.ok === false) return `${name}: summary says ok is false: ${file}`;
	const rev = doc.freshBuild?.head;
	if (typeof rev !== 'string' || !rev.startsWith(sha)) return `${name}: summary is for revision ${typeof rev === 'string' ? rev.slice(0, 12) : 'unknown'}, not HEAD ${sha}`;
	return null;
}

/**
 * Checks every step's prerequisite (each distinct `needs` once) before the first step and fails the gate on the first
 * problem without running anything; then runs `steps` in order and stops at the first failure. Returns `{ pass, failed, lines }`; `lines` is the whole
 * summary. `head` is `{ sha, dirty }`. `run` (returns a spawn result), `now`, `lock` and `env` (the environment checked for reduced-run variables) are injectable so a test needs no browser.
 */
export async function runGate(steps, { repo = REPO, head, lock = process.env.CLEARCASE_BROWSER_LOCK, run = exec, now = Date.now, env = process.env } = {}) {
	const logDir = join(repo, '.local', 'gate');
	mkdirSync(logDir, { recursive: true });
	const lines = [`gate ${head.sha} ${head.dirty ? 'DIRTY tree (not evidence)' : 'clean tree'}`];
	const reduced = reducedRun(env);
	if (reduced.length) return { pass: false, failed: 'env', lines: [...lines, ...reduced, `GATE FAIL env ${head.sha}`] };
	const checked = new Map();
	for (const step of steps) {
		if (!step.needs) continue;
		if (!checked.has(step.needs)) checked.set(step.needs, await step.needs(repo));
		const problem = checked.get(step.needs);
		if (!problem) continue;
		const log = join('.local', 'gate', logName(step));
		writeFileSync(join(repo, log), `${problem}\n`);
		return { pass: false, failed: step.name, lines: [...lines, `FAIL ${step.name} prerequisite (no step ran)`, ...problem.split('\n').map(clip), `see ${log}`, `GATE FAIL ${step.name} ${head.sha}`] };
	}
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
		const cmd = lock && step.browser ? [lock, ...step.cmd] : step.cmd;
		const sum = step.summary && { dir: join(repo, step.summary.dir), file: join(repo, step.summary.dir, step.summary.file) };
		if (sum) {
			rmSync(sum.file, { force: true });
			mkdirSync(sum.dir, { recursive: true });
		}
		const r = run(cmd, logFile, repo, sum && step.summary.env ? { [step.summary.env]: sum.dir } : {});
		let ok = r.status === 0 && !r.error && !r.signal;
		const why = failure(cmd, r);
		if (why) appendFileSync(logFile, `${why}\n`);
		const bad = ok && sum && summaryProblem(step, sum.file, head.sha);
		if (bad) {
			ok = false;
			appendFileSync(logFile, `${bad}\n`);
		}
		const seconds = Math.round((now() - start) / 1000);
		lines.push(`${ok ? 'PASS' : 'FAIL'} ${step.name} ${seconds}s`);
		if (!ok) {
			failed = step.name;
			tail = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim() !== '').slice(-TAIL_LINES).map(clip);
		}
	}
	if (failed) lines.push(...tail, `see ${join('.local', 'gate', logName(steps.find((s) => s.name === failed)))}`);
	lines.push(failed ? `GATE FAIL ${failed} ${head.sha}` : `GATE PASS ${head.sha}`);
	return { pass: !failed, failed, lines };
}

/** Reads the head SHA and tree state. Returns `{ head }`, or `{ error }` when a git call cannot run or exits non-zero. */
export function readHead(spawn = spawnSync, repo = REPO) {
	const git = (...args) => {
		const r = spawn('git', args, { cwd: repo, encoding: 'utf8' });
		if (r.error) return { error: r.error.message };
		if (r.status !== 0) return { error: `${args[0]} exited ${r.status ?? r.signal}: ${(r.stderr ?? '').trim()}` };
		return { out: r.stdout.trim() };
	};
	const sha = git('rev-parse', '--short=12', 'HEAD');
	if (sha.error) return { error: sha.error };
	const status = git('status', '--porcelain');
	if (status.error) return { error: status.error };
	return { head: { sha: sha.out, dirty: status.out !== '' } };
}

if (import.meta.main) {
	const { head, error } = readHead();
	if (error) {
		console.log(`GATE FAIL git ${error}`);
		process.exit(1);
	}
	const { pass, lines } = await runGate(STEPS, { head });
	console.log(lines.join('\n'));
	process.exit(pass ? 0 : 1);
}
