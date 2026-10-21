import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { isolatedBuild } from '../e2e/pilot/lib/isolated-build.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { gitIdentity } from '../e2e/pilot/v5/env.mjs';

// Revision reads that evidence depends on, when the caller's environment redirects Git (a Git hook, or another
// checkout's script, exports GIT_DIR and GIT_WORK_TREE): the head verify:pilot:v5 and the measure runners record
// (gitIdentity), the revision the local verify skill verifies and archives (its preflight, then isolatedBuild), and
// the tracked files the check step reads (check-links, source-check). Whatever the caller exported, each answers for
// the checkout asked about, never for the one the variables name. The PRFIX-84 sites are in
// browser-admission-git-env.test.ts. Synthetic checkouts only.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const VERIFY = join(REPO_ROOT, '.agents', 'skills', 'verify-clearcase', 'bin', 'verify-clearcase');
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'revision-git-env-')); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd: string, ...a: string[]) => {
	const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env: clean() });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
	return r.stdout.trim();
};
/** A checkout on branch `branch` with one commit whose content is `marker`, so two checkouts never share a SHA. */
function repository(dir: string, marker: string, branch: string) {
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', branch);
	writeFileSync(join(dir, '.gitignore'), '.local/\n');
	writeFileSync(join(dir, 'README.md'), `${marker}\n`);
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', marker);
	return dir;
}
/** The checkout asked about, and a different one the caller's Git variables name, with an untracked file in it. */
function checkouts() {
	const repo = repository(join(ws, 'clearcase'), 'the checkout asked about', 'asked');
	const other = repository(join(ws, 'other'), 'the checkout the variables name', 'named');
	writeFileSync(join(other, 'untracked.txt'), 'only in the other checkout\n');
	return { repo, other, repoSha: git(repo, 'rev-parse', 'HEAD'), otherSha: git(other, 'rev-parse', 'HEAD') };
}
const redirect = (other: string) => ({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other });
/** Runs `fn` with this process's GIT_* variables replaced by `vars`, as a hook or a calling script would have them, then restores. */
function exported<T>(vars: Record<string, string>, fn: () => T): T {
	const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_') || k in vars));
	for (const k of Object.keys(saved)) delete process.env[k];
	Object.assign(process.env, vars);
	try { return fn(); } finally {
		for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k in vars) delete process.env[k];
		Object.assign(process.env, saved);
	}
}
/** The error `fn` throws (isolatedBuild throws once it has archived a tree that has no bun.lock). */
const thrown = (fn: () => unknown) => { try { fn(); } catch (e) { return e as Error; } throw new Error('expected a throw'); };
/** A command run as the user runs it, in REPO_ROOT, with `vars` added to an environment that has no GIT_* variable. */
const run = (cmd: string, args: string[], vars: Record<string, string> = {}) => spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...clean(), ...vars } });
/** The facts the verify skill's preflight prints: a JSON object, then `preflight: PASS` when it passed. */
const preflightFacts = (vars: Record<string, string> = {}) => { const out = run(VERIFY, ['preflight'], vars).stdout; return JSON.parse(out.slice(0, out.lastIndexOf('\n}') + 2)); };
const ownHead = () => git(REPO_ROOT, 'rev-parse', 'HEAD');
const ownMarkdown = () => git(REPO_ROOT, 'ls-files', '-z').split('\0').filter((f) => f.endsWith('.md')).length;

describe('revision reads that evidence depends on ignore inherited Git directory overrides', () => {
	it('gitIdentity (verify:pilot:v5, the measure runners) names the head, branch and tree state of the checkout asked about', () => {
		const { repo, other, repoSha, otherSha } = checkouts();
		const id = exported(redirect(other), () => gitIdentity(repo));
		expect(id.head).not.toBe(otherSha);
		expect(id).toEqual({ head: repoSha, branch: 'asked', dirty: false, dirtyPaths: [] });
	});

	it('the local verify skill\'s preflight names the revision of its own checkout, not the one GIT_DIR names', () => {
		const { other, otherSha } = checkouts();
		const facts = preflightFacts(redirect(other));
		expect(facts.revision).not.toBe(otherSha);
		expect(facts.revision).toBe(ownHead());
	});

	it('isolatedBuild (the verify skill\'s build) resolves and archives the revision of the checkout asked about', () => {
		const { repo, other, repoSha, otherSha } = checkouts();
		const dir = join(ws, 'isolated');
		const e = exported(redirect(other), () => thrown(() => isolatedBuild({ repo, dir, log: () => {} })));
		expect(e.message).not.toContain(otherSha);
		expect(e.message).toBe(`${repoSha} has no bun.lock`);
		expect(readFileSync(join(dir, 'src', 'README.md'), 'utf8')).toBe('the checkout asked about\n');
	});

	it('the check step\'s link and source checks read the tracked files of their own checkout, not the one GIT_DIR names', () => {
		const { other } = checkouts();
		const links = run('bun', ['scripts/check-links.mjs'], redirect(other));
		expect(links.stdout.trim()).toBe(`check-links: ${ownMarkdown()} Markdown files, 0 broken link(s)`);
		expect(links.status).toBe(0);
		const source = run('bun', ['scripts/ci/source-check.ts'], redirect(other));
		expect(source.stdout).toContain('source-check: PASS');
		expect(source.status).toBe(0);
	});

	it('control: with no GIT_* variable set, each read answers for its checkout as before', () => {
		const { repo, repoSha } = checkouts();
		expect(exported({}, () => gitIdentity(repo))).toEqual({ head: repoSha, branch: 'asked', dirty: false, dirtyPaths: [] });
		writeFileSync(join(repo, 'new.txt'), 'untracked\n');
		expect(exported({}, () => gitIdentity(repo))).toEqual({ head: repoSha, branch: 'asked', dirty: true, dirtyPaths: ['new.txt'] });
		rmSync(join(repo, 'new.txt'));
		expect(preflightFacts().revision).toBe(ownHead());
		const dir = join(ws, 'isolated');
		expect(exported({}, () => thrown(() => isolatedBuild({ repo, dir, log: () => {} }))).message).toBe(`${repoSha} has no bun.lock`);
		expect(readFileSync(join(dir, 'src', 'README.md'), 'utf8')).toBe('the checkout asked about\n');
		const links = run('bun', ['scripts/check-links.mjs']);
		expect([links.status, links.stdout.trim()]).toEqual([0, `check-links: ${ownMarkdown()} Markdown files, 0 broken link(s)`]);
		const source = run('bun', ['scripts/ci/source-check.ts']);
		expect([source.status, source.stdout.includes('source-check: PASS')]).toEqual([0, true]);
	});
});
