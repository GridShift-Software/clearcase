import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { preflight } from '../../.agents/skills/verify-clearcase-hosted/lib/main.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { resolveBrowserLock } from '../../scripts/browser-lock.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { readHead as hostedReadHead } from '../../scripts/gate-hosted.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { readHead } from '../../scripts/gate.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { revisionStamp } from '../../scripts/verify/stamp.mjs';

// Browser admission and checkout identity when the caller's environment redirects Git (a Git hook, or another
// checkout's script, exports GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR). Whatever the caller exported, discovery and the
// head the gate reports depend on the checkout asked about, never on the one the variables name. Synthetic checkouts: a
// workspace holding `clearcase/` and `orch-bin/browser-lock`, and a second workspace the variables point at.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'gate-git-env-')); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]) => {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
	const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', ...a], { encoding: 'utf8', env });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
	return r.stdout.trim();
};
/** A checkout with one commit whose content is `marker`, so two checkouts never share a SHA; `.local/` is ignored. */
function repository(dir: string, marker: string) {
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q');
	writeFileSync(join(dir, '.gitignore'), '.local/\n');
	writeFileSync(join(dir, 'README.md'), `${marker}\n`);
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', marker);
	return dir;
}
const executable = (file: string, body: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); chmodSync(file, 0o755); return file; };
const lockIn = (root: string) => executable(join(root, 'orch-bin', 'browser-lock'), '#!/bin/sh\nexec "$@"\n');

/** The checkout asked about, and a different one the caller's Git variables name. */
function checkouts({ otherHasLock }: { otherHasLock: boolean }) {
	const repo = repository(join(ws, 'clearcase'), 'the checkout asked about');
	const mine = lockIn(ws);
	const other = repository(join(ws, 'other', 'clearcase'), 'the checkout the variables name');
	const theirs = otherHasLock ? lockIn(join(ws, 'other')) : null;
	return { repo, mine, other, theirs, repoSha: git(repo, 'rev-parse', 'HEAD'), otherSha: git(other, 'rev-parse', 'HEAD') };
}
const redirect = (other: string) => ({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other });
/** Runs `fn` with `vars` exported in this process, as a hook or a calling script would have them, then restores. */
function exported<T>(vars: Record<string, string>, fn: () => T): T {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	Object.assign(process.env, vars);
	try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

describe('lock discovery ignores inherited Git directory overrides', () => {
	it('discovers the repository\'s own lock with GIT_DIR and GIT_WORK_TREE naming a repository that has none', () => {
		const { repo, mine, other } = checkouts({ otherHasLock: false });
		const r = exported(redirect(other), () => resolveBrowserLock({ env: {}, repo }));
		expect(r).toEqual({ lock: mine, source: 'discovered' });
	});

	it('discovers the repository\'s own lock with GIT_COMMON_DIR naming a repository that has none', () => {
		const { repo, mine, other } = checkouts({ otherHasLock: false });
		const r = exported({ GIT_COMMON_DIR: join(other, '.git') }, () => resolveBrowserLock({ env: {}, repo }));
		expect(r).toEqual({ lock: mine, source: 'discovered' });
	});

	it('returns the repository\'s lock, never another workspace\'s, when the variables name a workspace that has one', () => {
		const { repo, mine, other, theirs } = checkouts({ otherHasLock: true });
		for (const vars of [redirect(other), { GIT_COMMON_DIR: join(other, '.git') }, { ...redirect(other), GIT_COMMON_DIR: join(other, '.git') }]) {
			const r = exported(vars, () => resolveBrowserLock({ env: {}, repo }));
			expect(r.lock).not.toBe(theirs);
			expect(r).toEqual({ lock: mine, source: 'discovered' });
		}
	});

	it('control: an explicit CLEARCASE_BROWSER_LOCK is used as before, with or without the variables', () => {
		const { repo, other } = checkouts({ otherHasLock: true });
		const explicit = executable(join(ws, 'elsewhere', 'lock'), '#!/bin/sh\nexec "$@"\n');
		expect(resolveBrowserLock({ env: { CLEARCASE_BROWSER_LOCK: explicit }, repo })).toEqual({ lock: explicit, source: 'explicit' });
		expect(exported(redirect(other), () => resolveBrowserLock({ env: { CLEARCASE_BROWSER_LOCK: explicit }, repo }))).toEqual({ lock: explicit, source: 'explicit' });
		expect(exported(redirect(other), () => resolveBrowserLock({ env: { CLEARCASE_BROWSER_LOCK: 'none' }, repo }))).toEqual({ lock: null, source: 'none' });
	});
});

describe('checkout identity ignores inherited Git directory overrides', () => {
	it('the local gate reports the head of the checkout it runs in, not the one GIT_DIR names', () => {
		const { repo, other, repoSha, otherSha } = checkouts({ otherHasLock: false });
		const r = exported(redirect(other), () => readHead(undefined, repo));
		expect(r.head).toEqual({ sha: repoSha.slice(0, 12), dirty: false });
		expect(r.head.sha).not.toBe(otherSha.slice(0, 12));
	});

	it('gate:hosted reports the head of the checkout it runs in, not the one GIT_DIR names', () => {
		const { repo, other, repoSha, otherSha } = checkouts({ otherHasLock: false });
		const r = exported(redirect(other), () => hostedReadHead(repo));
		expect(r.head.sha).toBe(repoSha);
		expect(r.head.sha).not.toBe(otherSha);
		expect(r.head.dirty).toBe(false);
	});

	it('the revision stamp names the head of the checkout it is written in, not the one GIT_DIR names', () => {
		const { repo, other, repoSha } = checkouts({ otherHasLock: false });
		const stamp = exported(redirect(other), () => revisionStamp(repo));
		expect(stamp.head).toBe(repoSha);
		expect(stamp.dirty).toBe(false);
	});

	it('the hosted runner\'s preflight names the revision of its own checkout, not the one GIT_DIR names', () => {
		const { other, otherSha } = checkouts({ otherHasLock: false });
		const own = git(REPO_ROOT, 'rev-parse', 'HEAD');
		const r = exported(redirect(other), () => preflight({ port: { app: 43790, canary: 43791 } }));
		expect(r.facts.revision).not.toBe(otherSha);
		expect(r.facts.revision).toBe(own);
	});

	it('scripts/verify/evidence.sh stamps the revision of its own checkout, not the one GIT_DIR names', () => {
		const { repo, other, otherSha } = checkouts({ otherHasLock: false });
		for (const f of ['scripts/browser-lock.mjs', 'scripts/verify/evidence.sh']) {
			mkdirSync(join(repo, f, '..'), { recursive: true });
			copyFileSync(join(REPO_ROOT, f), join(repo, f));
		}
		writeFileSync(join(repo, 'scripts', 'verify', 'matrix.mjs'), 'console.log("matrix stub", process.argv.slice(2).join(" "));\n');
		git(repo, 'add', '.');
		git(repo, 'commit', '-q', '-m', 'evidence script and a matrix stub');
		const sha = git(repo, 'rev-parse', 'HEAD');
		const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), CLEARCASE_BROWSER_LOCK: 'none', ...redirect(other) };
		const r = spawnSync('bash', [join(repo, 'scripts', 'verify', 'evidence.sh'), 'matrix'], { cwd: repo, encoding: 'utf8', env });
		expect(r.stdout).toContain(`evidence: exit 0 at ${sha}`);
		expect(r.stdout).not.toContain(otherSha);
	});
});
