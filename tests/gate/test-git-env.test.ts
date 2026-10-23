import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A test run must never write into another repository. A Git hook (or another checkout's script) that runs the tests
// exports GIT_DIR, and every scratch repository a test builds with a bare `git` call would then be built in the
// repository the variable names (the commits land on its branch). The test boundary strips GIT_*: scripts/gate.mjs gives
// each step an environment without it, and tests/setup/strip-git-env.ts, listed by every tracked Vitest config, deletes it for a direct
// `bun run --bun test` or `vitest --config <config>`.
// Synthetic repositories only.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
let ws: string, target: string;
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const nestedCallers = [
	['deployment', 'summary-check.test.ts', 'a docs-only commit after the run passes'],
	['identity', 'check.test.ts', 'a later commit outside the inputs'],
] as const;
const nestedTest = (name: (typeof nestedCallers)[number][0], file: string, title: string, env: NodeJS.ProcessEnv) =>
	spawnSync('bun', ['run', '--bun', 'test', file, '-t', title], { cwd: join(REPO_ROOT, 'tests', 'hosting-probe', name), encoding: 'utf8', env });
const git = (cwd: string, ...a: string[]) => {
	const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env: clean() });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
	return r.stdout.trim();
};
const commits = () => Number(git(target, 'rev-list', '--count', 'HEAD'));
beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), 'test-git-env-'));
	target = join(ws, 'target');
	git(ws, 'init', '-q', '-b', 'main', target);
	writeFileSync(join(target, 'README.md'), 'the repository the variables name\n');
	git(target, 'add', '.');
	git(target, 'commit', '-q', '-m', 'target');
});
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

describe('a test run with an inherited GIT_DIR leaves that repository alone', () => {
	// tests/gate/ci-summary.test.ts builds its scratch checkout with a bare `git init` and `git commit`
	const hooked = () => ({ ...clean(), GIT_DIR: join(target, '.git') });

	it('bun run --bun test (direct, as a hook runs it) writes no commit into the repository GIT_DIR names', () => {
		const before = commits();
		const r = spawnSync('bun', ['run', '--bun', 'test', 'tests/gate/ci-summary.test.ts'], { cwd: REPO_ROOT, encoding: 'utf8', env: hooked() });
		expect(commits(), 'commits the test run wrote into the repository GIT_DIR names').toBe(before);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(git(target, 'log', '-1', '--format=%s')).toBe('target');
	});

	it('a gate step (scripts/gate.mjs exec) is given an environment without GIT_*', async () => {
		// @ts-expect-error plain .mjs script, no declarations
		const { exec } = await import('../../scripts/gate.mjs');
		const log = join(ws, 'step.log');
		exec(['env'], log, ws, { CLEARCASE_E2E_OUT: 'x' }, hooked());
		const seen = readFileSync(log, 'utf8').split('\n');
		expect(seen.filter((l) => l.startsWith('GIT_'))).toEqual([]);
		expect(seen).toContain('CLEARCASE_E2E_OUT=x');
	});

	// tests/parity/stale-build.test.ts builds its scratch checkout with a bare `git init` and `git commit`
	it('a documented direct run of the parity config (vitest --config tests/parity/vitest.config.ts) writes no commit either', () => {
		const before = commits();
		const r = spawnSync('bunx', ['vitest', 'run', '--config', 'tests/parity/vitest.config.ts', 'tests/parity/stale-build.test.ts'], { cwd: REPO_ROOT, encoding: 'utf8', env: hooked() });
		expect(commits(), 'commits the parity run wrote into the repository GIT_DIR names').toBe(before);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(git(target, 'log', '-1', '--format=%s')).toBe('target');
	});

	// Each direct TypeScript Vitest entry wires the strip. The separately inventoried Workers config runs only through
	// deployment P5, whose caller supplies an allowlisted environment.
	it.each(['vitest.config.ts', 'tests/parity/vitest.config.ts', 'tests/acceptance/CC-23/vitest.config.ts', 'tests/hosting-probe/deployment/vitest.config.ts', 'tests/hosting-probe/identity/vitest.config.ts'])('%s runs tests/setup/strip-git-env.ts first', async (config) => {
		const { default: cfg } = await import(pathToFileURL(join(REPO_ROOT, config)).href);
		const entries: string[] = cfg.test?.setupFiles ?? [];
		// Root-run configs resolve relative entries against the repository root; nested configs use absolute, config-relative entries.
		const resolved = entries.map((e) => resolve(REPO_ROOT, e));
		expect(resolved[0], `${config} test.setupFiles`).toBe(join(REPO_ROOT, 'tests', 'setup', 'strip-git-env.ts'));
	});

	it('the list above is every tracked Vitest config', () => {
		const tracked = spawnSync('git', ['ls-files', '*vitest.config.*', '*vitest.workspace.*', '*vitest.*.config.*'], { cwd: REPO_ROOT, encoding: 'utf8', env: clean() }).stdout.split('\n').filter(Boolean).sort();
		expect(tracked).toEqual([
			'tests/acceptance/CC-23/vitest.config.ts',
			'tests/hosting-probe/deployment/app/vitest.workers.config.mjs',
			'tests/hosting-probe/deployment/vitest.config.ts',
			'tests/hosting-probe/identity/vitest.config.ts',
			'tests/parity/vitest.config.ts',
			'vitest.config.ts',
		]);
	});

	it.each(nestedCallers)('%s direct package test preserves Git isolation with a clean environment', (name, file, title) => {
		const before = commits();
		const r = nestedTest(name, file, title, clean());
		expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
		expect(commits()).toBe(before);
		expect(git(target, 'log', '-1', '--format=%s')).toBe('target');
	});

	it.each(nestedCallers)('%s direct package test strips inherited Git redirection', (name, file, title) => {
		const before = commits();
		const r = nestedTest(name, file, title, { ...clean(), GIT_DIR: join(target, '.git'), GIT_WORK_TREE: target });
		expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
		expect(commits(), 'the direct nested run changed the synthetic repository named by inherited GIT_*').toBe(before);
		expect(git(target, 'log', '-1', '--format=%s')).toBe('target');
	});
});

// exec's environment is the gate's own without GIT_*. The case above asserts that on the real exec; this one proves the
// assertion can fail: the same call against exec with its `gitEnv(base)` taken out of the environment sees the leak.
describe('the gate-step check detects a leaked GIT_*', () => {
	const seenIn = (exec: (...a: unknown[]) => unknown, dir: string, name: string) => {
		const log = join(dir, `${name}.log`); // exec appends, so each run has its own
		exec(['env'], log, dir, {}, { ...clean(), GIT_DIR: join(target, '.git'), GIT_WORK_TREE: target });
		return readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('GIT_')).map((l) => l.split('=')[0]).sort();
	};

	it('sees GIT_DIR and GIT_WORK_TREE in a step whose environment was built without the strip, and none in the real one', async () => {
		const gate = join(REPO_ROOT, 'scripts', 'gate.mjs');
		const source = readFileSync(gate, 'utf8');
		const leaky = source.replace('env: { ...gitEnv(base), ...env }', 'env: { ...base, ...env }');
		expect(leaky, "scripts/gate.mjs's exec no longer builds its env as { ...gitEnv(base), ...env }; update this control").not.toBe(source);
		// a copy in the scratch directory, its relative imports pointed back at the repository
		const copy = join(ws, 'gate-leaky.mjs');
		writeFileSync(copy, leaky.replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(resolve(dirname(gate), rel)).href}'`));
		try {
			// @ts-expect-error plain .mjs script, no declarations
			const real = (await import('../../scripts/gate.mjs')).exec;
			const mutated = (await import(pathToFileURL(copy).href)).exec;
			expect(seenIn(mutated, ws, 'mutated'), 'the control: exec without the strip leaks').toEqual(['GIT_DIR', 'GIT_WORK_TREE']);
			expect(seenIn(real, ws, 'real')).toEqual([]);
		} finally {
			rmSync(copy, { force: true });
		}
	});
});
