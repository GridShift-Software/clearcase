// GRS-155 fix round 1 (H1): a failed `test guard` step must itself fail the job, before any code the pull request supplies
// can run. The review found it did not: the step had continue-on-error and a later `test guard verdict` step turned its
// outcome into the job's, after the pull request's install scripts had run, so a postinstall that put BASH_ENV in
// GITHUB_ENV, or a `bash` shim on GITHUB_PATH, made that step exit 0 and the job green.
//
// This replays the workflow's real steps the way the runner runs them (bash --noprofile --norc -eo pipefail, GITHUB_ENV
// and GITHUB_PATH applied to later steps, `bash` resolved on the job's PATH, `if` and continue-on-error deciding which
// steps run and what counts as a failed step) in a synthetic repository, and asserts the job's conclusion, which only
// the step exit codes and continue-on-error decide. The base's guard is a stub that exits 1 (FAIL) or has no bun.lock
// to install (HOLD), so no registry is needed; tests/ci-guard/run.sh replays the same step against the real guard.
// Emulation, not a real runner: the first pull request to run the workflow on GitHub is the real check. It claims
// nothing about a hostile workflow file or the runner's persistent caches (docs/ci-runner.md).
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Step = { name?: string; id?: string; if?: string; 'continue-on-error'?: boolean; env?: Record<string, string>; run?: string; uses?: string };
const { Bun: bun } = globalThis as unknown as { Bun: { YAML: { parse(s: string): { jobs: Record<string, { steps: Step[] }> } } } };
const workflow = bun.YAML.parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs.check!.steps;

const guardOf = (all: Step[]) => all.find((s) => s.name === 'test guard')!;
// The steps whose result depends on the guard or on the pull request's install: the guard, the install the job runs
// next, and any step that reads the guard's outcome (the reviewed workflow's `test guard verdict`). The other steps
// need Chrome, Node, Chromium and the whole repository, and say nothing about the guard.
const readsGuard = (s: Step, guard: Step) => JSON.stringify([s.if, s.env]).includes(`steps.${guard.id}.outcome`);
function replayed(all: Step[]): Step[] {
	const guard = guardOf(all);
	return all.filter((s) => s === guard || String(s.run ?? '').trim() === 'bun install --frozen-lockfile' || readsGuard(s, guard));
}

const STATUS = /\b(success|failure|always|cancelled)\(\)/;
function holds(condition: string | undefined, failed: boolean, outcomes: Record<string, string>): boolean {
	if (condition === undefined) return !failed;
	const atoms = condition.replace(/^\s*\$\{\{|\}\}\s*$/g, '').split('&&').map((a) => a.trim());
	const implicit = STATUS.test(condition) || !failed;
	return implicit && atoms.every((a) => {
		const outcome = /^steps\.([\w-]+)\.outcome == '(\w+)'$/.exec(a);
		if (outcome) return outcomes[outcome[1]!] === outcome[2];
		switch (a) {
			case '!cancelled()': case 'always()': case "github.event_name == 'pull_request'": return true;
			case 'success()': return !failed;
			case 'failure()': return failed;
		}
		throw new Error(`guard-enforcement.test.ts cannot evaluate the condition ${a}; teach holds() before the workflow uses it`);
	});
}

let root = '', origin = '', home = '', cache = '';
const bunDir = path.dirname(process.execPath);
const sha: Record<string, string> = {};
const clean = () => ({ PATH: `${bunDir}:${process.env.PATH}`, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', BUN_INSTALL_CACHE_DIR: cache });
function run(cwd: string, cmd: string, ...args: string[]): string {
	const r = spawnSync(cmd, args, { cwd, env: clean(), encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} in ${cwd}: ${r.stderr}${r.stdout}`);
	return r.stdout.trim();
}
const git = (...args: string[]) => run(origin, 'git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args);
const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };

const STUB_FAIL = '#!/bin/bash\necho "test-guard: FAIL (a named test was weakened)" >&2\nexit 1\n';
const STUB_PASS = '#!/bin/bash\necho "test-guard: PASS (1 named tests)"\nexit 0\n';
// What a pull request's postinstall does to a later step: nothing, a BASH_ENV file that exits 0, a `bash` that exits 0.
const POSTINSTALL: Record<string, string> = {
	benign: 'echo postinstall',
	'bash-env': 'printf "exit 0\\n" > "$PWD/.pass.sh"; echo "BASH_ENV=$PWD/.pass.sh" >> "$GITHUB_ENV"',
	'github-path': 'mkdir -p .shim; printf "#!/bin/sh\\nexit 0\\n" > .shim/bash; chmod +x .shim/bash; echo "$PWD/.shim" >> "$GITHUB_PATH"',
};
POSTINSTALL.both = `${POSTINSTALL['bash-env']}; ${POSTINSTALL['github-path']}`;

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), 'ci-guard-enforcement-'));
	home = path.join(root, 'home');
	cache = path.join(root, 'bun-cache');
	origin = path.join(root, 'origin');
	mkdirSync(home);
	mkdirSync(path.join(origin, 'localdep'), { recursive: true });
	const pkg = (scripts?: Record<string, string>) => JSON.stringify({ name: 'fixture', private: true, dependencies: { localdep: 'file:./localdep' }, ...(scripts && { scripts }) }) + '\n';
	const lock = () => run(origin, 'bun', '--no-env-file', 'install', '--ignore-scripts');
	git('init', '-q', '-b', 'dev-pass');
	writeFileSync(path.join(origin, '.gitignore'), 'node_modules\n');
	writeFileSync(path.join(origin, 'localdep/package.json'), '{"name":"localdep","version":"1.0.0"}\n');
	writeFileSync(path.join(origin, 'package.json'), pkg());
	lock();
	mkdirSync(path.join(origin, 'scripts/agent-tools'), { recursive: true });
	const guardFile = path.join(origin, 'scripts/agent-tools/fix-round-guard');
	writeFileSync(guardFile, STUB_PASS);
	chmodSync(guardFile, 0o755);
	commit('base: a guard that passes');
	git('switch', '-q', '-c', 'dev-fail', 'dev-pass');
	writeFileSync(guardFile, STUB_FAIL);
	commit('base: a guard that fails');
	git('switch', '-q', '-c', 'dev-nolock', 'dev-pass');
	git('rm', '-q', 'bun.lock');
	commit('base: no bun.lock, so nothing can be installed or judged');
	for (const [route, postinstall] of Object.entries(POSTINSTALL)) {
		git('switch', '-q', '-c', `pr-${route}`, 'dev-pass');
		writeFileSync(path.join(origin, 'package.json'), pkg({ postinstall }));
		lock();
		sha[route] = commit(`pull request: ${route}`);
	}
}, 120_000);
afterAll(() => { if (root) { run(root, 'chmod', '-R', 'u+w', root); rmSync(root, { recursive: true, force: true }); } });

type Ran = { name: string; outcome: string; conclusion: string; rc: number | null; tail: string };
type Job = { conclusion: 'success' | 'failure'; steps: Ran[]; effects: string[] };
const summary = (job: Job) => job.steps.map((s) => `${s.name}: ${s.outcome}${s.outcome === s.conclusion ? '' : ` (counted as ${s.conclusion})`}`).join('; ') + `; effects [${job.effects.join(', ')}]`;
function resolve(command: string, searchPath: string): string {
	for (const dir of searchPath.split(':')) {
		const candidate = path.join(dir, command);
		try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
	}
	throw new Error(`no ${command} on ${searchPath}`);
}

// One run of the job's replayed steps. `forced` makes every step after the guard run whatever happened before, as a
// step with `if: always()` would, so a refused pull request's hostile install runs even where the workflow skips it.
function runJob(all: Step[], { base, route, forced = false }: { base: string; route: string; forced?: boolean }): Job {
	const guard = guardOf(all);
	const dir = mkdtempSync(path.join(root, 'job-'));
	const ws = path.join(dir, 'workspace'), runnerTemp = path.join(dir, 'runner-temp'), tmp = path.join(dir, 'tmp');
	for (const d of [runnerTemp, tmp]) mkdirSync(d);
	run(root, 'git', 'clone', '-q', origin, ws);
	run(ws, 'git', 'checkout', '-q', '--detach', sha[route]!);
	let jobPath = `${bunDir}:/usr/local/bin:/usr/bin:/bin`, failed = false;
	const added: Record<string, string> = {}, outcomes: Record<string, string> = {}, steps: Ran[] = [], effects: string[] = [];
	const expressions: Record<string, string> = {
		'github.event.pull_request.head.sha': sha[route]!, 'github.base_ref': base, 'github.head_ref': `pr-${route}`,
		"contains(github.event.pull_request.labels.*.name, 'fix-round')": 'false',
	};
	replayed(all).forEach((step, i) => {
		const entry = forced && step !== guard ? { ...step, if: 'always()' } : step;
		const name = step.name ?? step.run!.trim();
		if (!holds(entry.if, failed, outcomes)) { steps.push({ name, outcome: 'skipped', conclusion: 'skipped', rc: null, tail: '' }); return; }
		const envFile = path.join(dir, `github-env-${i}`), pathFile = path.join(dir, `github-path-${i}`), script = path.join(dir, `step-${i}.sh`);
		writeFileSync(envFile, '');
		writeFileSync(pathFile, '');
		writeFileSync(script, String(entry.run));
		const env: Record<string, string> = {
			PATH: jobPath, HOME: home, TMPDIR: tmp, BUN_INSTALL_CACHE_DIR: cache, RUNNER_TEMP: runnerTemp, GITHUB_ENV: envFile, GITHUB_PATH: pathFile, GITHUB_ACTIONS: 'true', ...added,
		};
		for (const [k, v] of Object.entries(entry.env ?? {})) {
			env[k] = v.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, e: string) => {
				const outcome = /^steps\.([\w-]+)\.outcome$/.exec(e);
				const value = outcome ? outcomes[outcome[1]!] : expressions[e];
				if (value === undefined) throw new Error(`guard-enforcement.test.ts cannot expand \${{ ${e} }}`);
				return value;
			});
		}
		const r = spawnSync(resolve('bash', jobPath), ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: ws, env, encoding: 'utf8', timeout: 120_000 });
		const outcome = r.status === 0 ? 'success' : 'failure';
		const conclusion = outcome === 'failure' && entry['continue-on-error'] === true ? 'success' : outcome;
		if (step.id) outcomes[step.id] = outcome;
		failed ||= conclusion === 'failure';
		for (const line of readFileSync(pathFile, 'utf8').split('\n')) if (line) { jobPath = `${line}:${jobPath}`; effects.push('GITHUB_PATH'); }
		for (const line of readFileSync(envFile, 'utf8').split('\n')) {
			const m = /^([^=\s]+)=(.*)$/.exec(line);
			if (m) { added[m[1]!] = m[2]!; effects.push(m[1]!); }
		}
		steps.push({ name, outcome, conclusion, rc: r.status, tail: `${r.stderr}${r.stdout}`.trim().split('\n').slice(-2).join(' | ') });
	});
	return { conclusion: failed ? 'failure' : 'success', steps, effects };
}
const step = (job: Job, name: string) => job.steps.find((s) => s.name === name)!;

describe('CI test guard enforcement', () => {
	const REFUSALS = [['FAIL, the pull request weakened a named test', 'dev-fail', 1], ['HOLD, the base leaves nothing to install and judge', 'dev-nolock', 2]] as const;
	const ROUTES = [['an install that does nothing', 'benign'], ['BASH_ENV in GITHUB_ENV', 'bash-env'], ['a bash shim on GITHUB_PATH', 'github-path'], ['both', 'both']] as const;

	describe.each(REFUSALS)('a guard %s', (_, base, rc) => {
		describe.each(ROUTES)('and %s', (_route, route) => {
			it('fails the job', () => {
				const job = runJob(workflow, { base, route });
				expect(step(job, 'test guard').rc, summary(job)).toBe(rc);
				expect(job.conclusion, summary(job)).toBe('failure');
			});
			it('fails the job even when the pull request\'s install runs after it', () => {
				const job = runJob(workflow, { base, route, forced: true });
				expect(step(job, 'bun install --frozen-lockfile').outcome, summary(job)).toBe('success');
				if (route !== 'benign') expect(job.effects.length, `the route fired: ${summary(job)}`).toBeGreaterThan(0);
				expect(job.conclusion, summary(job)).toBe('failure');
			});
		});
	});

	it.each(ROUTES)('lets a pull request the guard passes through, with %s', (_route, route) => {
		const job = runJob(workflow, { base: 'dev-pass', route });
		expect(step(job, 'test guard').outcome, summary(job)).toBe('success');
		expect(step(job, 'bun install --frozen-lockfile').outcome, summary(job)).toBe('success');
		expect(job.conclusion, summary(job)).toBe('success');
	});

	// The assertions above must fail when the failure is not direct. These change the workflow's own steps.
	describe('the emulation catches', () => {
		const guard = guardOf(workflow);
		const swallowed = () => workflow.map((s) => (s === guard ? { ...s, 'continue-on-error': true } : s));
		const reviewed = (): Step[] => [
			...swallowed().filter((s) => !readsGuard(s, guard)),
			{
				name: 'test guard verdict', if: guard.if, env: { OUTCOME: `\${{ steps.${guard.id}.outcome }}` },
				run: '[ "$OUTCOME" = success ] || { echo "test guard: $OUTCOME, not success; the test guard step\'s log says why" >&2; exit 1; }',
			},
		];
		it('a guard whose failure is swallowed by continue-on-error', () => {
			const job = runJob(swallowed().filter((s) => !readsGuard(s, guard)), { base: 'dev-fail', route: 'benign' });
			expect(step(job, 'test guard').outcome).toBe('failure');
			expect(job.conclusion, summary(job)).toBe('success');
		});
		// The reviewed workflow (eef0c562): the verdict step settles the job after the install, and the install can clear it.
		it.each([['benign', 'failure'], ['bash-env', 'success'], ['github-path', 'success'], ['both', 'success']] as const)('a later verdict step, with %s: job %s', (route, conclusion) => {
			const job = runJob(reviewed(), { base: 'dev-fail', route });
			expect(job.conclusion, summary(job)).toBe(conclusion);
		});
	});
});
