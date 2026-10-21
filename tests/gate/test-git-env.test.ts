import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A test run must never write into another repository. A Git hook (or another checkout's script) that runs the tests
// exports GIT_DIR, and every scratch repository a test builds with a bare `git` call would then be built in the
// repository the variable names (the commits land on its branch). The test boundary strips GIT_*: scripts/gate.mjs gives
// each step an environment without it, and vitest.config.ts's setup file deletes it for a direct `bun run --bun test`.
// Synthetic repositories only.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
let ws: string, target: string;
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
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
});
