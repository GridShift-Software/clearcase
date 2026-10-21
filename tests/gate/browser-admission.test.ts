import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { hostedRun, preflight } from '../../.agents/skills/verify-clearcase-hosted/lib/main.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { resolveBrowserLock } from '../../scripts/browser-lock.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { runHostedGate } from '../../scripts/gate-hosted.mjs';
// @ts-expect-error plain .mjs script, no declarations
import { readHead, runGate } from '../../scripts/gate.mjs';

// The gate's browser admission and checkout identity, against synthetic checkouts: a workspace directory holding the
// repository `clearcase/`, a linked worktree under `worktrees/`, and `orch-bin/browser-lock` as a stub that records each
// command it wraps and runs it.
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'gate-admission-')); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]) => {
	const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', ...a], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
	return r.stdout.trim();
};
/** A checkout with one commit; `.local/` (the gate's logs) is ignored, as in the repository. */
function repository(dir = join(ws, 'clearcase')) {
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q');
	writeFileSync(join(dir, '.gitignore'), '.local/\n');
	writeFileSync(join(dir, 'README.md'), 'synthetic\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'synthetic');
	return dir;
}
const executable = (file: string, body: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); chmodSync(file, 0o755); return file; };
/** The workspace lock stub: appends the command it wraps to `<ws>/calls`, then runs it. */
const workspaceLock = () => executable(join(ws, 'orch-bin', 'browser-lock'), `#!/bin/sh\necho "$*" >> "${join(ws, 'calls')}"\nexec "$@"\n`);
const calls = () => (existsSync(join(ws, 'calls')) ? readFileSync(join(ws, 'calls'), 'utf8').trim().split('\n') : []);
const headOf = (repo: string) => readHead(undefined, repo).head as { sha: string; dirty: boolean };
type Step = { name: string; cmd: string[]; browser?: boolean };
const quiet: Step[] = [{ name: 'a', cmd: ['true'] }, { name: 'b', cmd: ['true'], browser: true }];

/** Runs the gate over `steps` in `repo` with `env` as the caller's environment; records every command it starts. */
async function gate(repo: string, env: Record<string, string>, steps: Step[] = quiet) {
	const ran: string[][] = [];
	const run = (cmd: string[], logFile: string, cwd: string) => {
		ran.push(cmd);
		return spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: ['ignore', 'ignore', 'ignore'], env: { PATH: process.env.PATH } });
	};
	const head = headOf(repo);
	const r = await runGate(steps, { repo, head, env, run });
	return { ...r, ran, head };
}

describe('browser admission before any step', () => {
	it('refuses a gate with no admission: CLEARCASE_BROWSER_LOCK unset and no workspace lock to discover', async () => {
		const repo = repository();
		const r = await gate(repo, {});
		expect(r.ran).toEqual([]);
		expect(r.lines.join('\n')).toMatch(/CLEARCASE_BROWSER_LOCK/);
		expect(r.lines.at(-1)).toBe(`GATE FAIL env ${r.head.sha}`);
	});

	it.each([
		['empty', () => ''],
		['relative', () => 'orch-bin/browser-lock'],
		['missing', () => join(ws, 'nowhere', 'browser-lock')],
		['not executable', () => { const f = join(ws, 'plain-lock'); writeFileSync(f, '#!/bin/sh\nexec "$@"\n'); return f; }],
		['a directory', () => ws],
		['NONE in capitals', () => 'NONE'],
	])('refuses an invalid explicit CLEARCASE_BROWSER_LOCK (%s), even when a workspace lock is discoverable', async (_n, value) => {
		const repo = repository();
		workspaceLock();
		const v = value();
		const r = await gate(repo, { CLEARCASE_BROWSER_LOCK: v });
		expect(r.ran).toEqual([]);
		expect(calls()).toEqual([]);
		expect(r.lines.join('\n')).toContain(`CLEARCASE_BROWSER_LOCK=${JSON.stringify(v)}`);
		expect(r.lines.at(-1)).toBe(`GATE FAIL env ${r.head.sha}`);
	});

	it('refuses the retired BROWSER_LOCK spelling, alone or beside a valid CLEARCASE_BROWSER_LOCK', async () => {
		const repo = repository();
		const lock = workspaceLock();
		for (const env of [{ BROWSER_LOCK: lock }, { BROWSER_LOCK: '' }, { BROWSER_LOCK: lock, CLEARCASE_BROWSER_LOCK: lock }] as Record<string, string>[]) {
			const r = await gate(repo, env);
			expect(r.ran).toEqual([]);
			expect(r.lines.join('\n')).toMatch(/BROWSER_LOCK is the retired spelling/);
			expect(r.lines.at(-1)).toBe(`GATE FAIL env ${r.head.sha}`);
		}
		expect(calls()).toEqual([]);
	});
});

describe('browser admission precedence', () => {
	it('discovers the workspace lock through git-common-dir from the main checkout and from a linked worktree', async () => {
		const repo = repository();
		const lock = workspaceLock();
		const linked = join(ws, 'worktrees', 'feature');
		git(repo, 'worktree', 'add', '-q', '--detach', linked);
		for (const dir of [repo, linked]) {
			const r = await gate(dir, {});
			expect(r.lines.at(-1)).toBe(`GATE PASS ${r.head.sha}`);
			expect(r.ran).toEqual([['true'], [lock, 'true']]);
			expect(r.lines).toContain(`browser lock ${lock} (discovered from git-common-dir)`);
		}
		expect(calls()).toEqual(['true', 'true']);
	});

	it('an explicit absolute executable wins over the discovered lock', async () => {
		const repo = repository();
		workspaceLock();
		const other = executable(join(ws, 'elsewhere', 'lock'), '#!/bin/sh\nexec "$@"\n');
		const r = await gate(repo, { CLEARCASE_BROWSER_LOCK: other });
		expect(r.ran).toEqual([['true'], [other, 'true']]);
		expect(r.lines).toContain(`browser lock ${other} (CLEARCASE_BROWSER_LOCK)`);
		expect(calls()).toEqual([]);
	});

	it('none runs browser steps without a slot, deliberately, even when a workspace lock is discoverable', async () => {
		const repo = repository();
		workspaceLock();
		const r = await gate(repo, { CLEARCASE_BROWSER_LOCK: 'none' });
		expect(r.lines.at(-1)).toBe(`GATE PASS ${r.head.sha}`);
		expect(r.ran).toEqual([['true'], ['true']]);
		expect(r.lines).toContain('browser lock none (CLEARCASE_BROWSER_LOCK=none: browser steps take no slot)');
		expect(calls()).toEqual([]);
	});
});

describe('checkout identity', () => {
	const none = { CLEARCASE_BROWSER_LOCK: 'none' };
	it('passes when HEAD and the tree are unchanged', async () => {
		const r = await gate(repository(), none);
		expect(r.pass).toBe(true);
		expect(r.lines.at(-1)).toBe(`GATE PASS ${r.head.sha}`);
	});

	it('fails head when a step leaves an untracked file, after every step passed', async () => {
		const r = await gate(repository(), none, [{ name: 'a', cmd: ['sh', '-c', 'echo probe > stray.txt'] }, quiet[1]!]);
		expect(r.lines.some((l: string) => /^PASS a \d+s$/.test(l))).toBe(true);
		expect(r.lines.find((l: string) => l.startsWith('FAIL head'))).toMatch(/clean at entry, dirty now/);
		expect(r.lines.at(-1)).toBe(`GATE FAIL head ${r.head.sha}`);
	});

	it('fails head when HEAD moves during the gate, even though the tree is clean again', async () => {
		const r = await gate(repository(), none, [{ name: 'a', cmd: ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'moved'] }]);
		const now = headOf(join(ws, 'clearcase'));
		expect(now.sha).not.toBe(r.head.sha);
		expect(r.lines.find((l: string) => l.startsWith('FAIL head'))).toContain(`HEAD ${r.head.sha} at entry, ${now.sha} now`);
		expect(r.lines.at(-1)).toBe(`GATE FAIL head ${r.head.sha}`);
	});

	it('never passes a tree that was dirty at entry: its steps run, but it is not evidence for any SHA', async () => {
		const repo = repository();
		writeFileSync(join(repo, 'wip.txt'), 'uncommitted\n');
		const r = await gate(repo, none);
		expect(r.lines[0]).toMatch(/DIRTY/);
		expect(r.ran).toEqual([['true'], ['true']]);
		expect(r.lines.at(-1)).toBe(`GATE FAIL head ${r.head.sha}`);
	});

	it('a probe in a detached worktree of the same repository leaves the tested checkout clean', async () => {
		const repo = repository();
		const before = headOf(repo);
		const probe = join(ws, 'worktrees', '.probe');
		git(repo, 'worktree', 'add', '-q', '--detach', probe);
		writeFileSync(join(probe, 'probe.test.ts'), 'throwaway\n');
		git(probe, 'add', '.');
		git(probe, 'commit', '-q', '-m', 'probe');
		writeFileSync(join(probe, 'untracked.txt'), 'x\n');
		expect(headOf(repo)).toEqual(before);
		git(repo, 'worktree', 'remove', '--force', probe);
		expect(headOf(repo)).toEqual(before);
	});
});

// The other entry points resolve through scripts/browser-lock.mjs too: evidence.sh (run as a copy in the synthetic
// workspace, with a stub for its metrics step), the hosted runner's preflight, and gate:hosted through that preflight.
const REPO = join(import.meta.dirname, '..', '..');
const PATH = `${join(process.execPath, '..')}:${process.env.PATH}`;
const STUB_METRICS = "console.log('metrics ran');\n";

/** A synthetic checkout carrying this revision's evidence.sh and browser-lock.mjs, with a stub metrics step. */
function evidenceCheckout() {
	const repo = repository();
	for (const f of ['scripts/verify/evidence.sh', 'scripts/browser-lock.mjs']) {
		mkdirSync(join(repo, f, '..'), { recursive: true });
		writeFileSync(join(repo, f), readFileSync(join(REPO, f)));
	}
	chmodSync(join(repo, 'scripts/verify/evidence.sh'), 0o755);
	writeFileSync(join(repo, 'scripts/verify/metrics.mjs'), STUB_METRICS);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'evidence');
	return repo;
}
const evidence = (repo: string, env: Record<string, string>) => {
	const r = spawnSync(join(repo, 'scripts/verify/evidence.sh'), ['metrics'], { encoding: 'utf8', env: { PATH, HOME: process.env.HOME!, ...env } });
	const log = join(repo, '.local', 'GRS-21', 'metrics.log');
	return { ...r, ran: existsSync(log) && readFileSync(log, 'utf8').includes('metrics ran') };
};

describe('evidence.sh admits browser steps through the same contract', () => {
	it('discovers the workspace lock from the main checkout and from a linked worktree, and runs the step through it', () => {
		const repo = evidenceCheckout();
		const lock = workspaceLock();
		const linked = join(ws, 'worktrees', 'evidence');
		git(repo, 'worktree', 'add', '-q', '--detach', linked);
		for (const dir of [repo, linked]) {
			const r = evidence(dir, {});
			expect(r.status, r.stderr).toBe(0);
			expect(r.stderr).toContain(`browser lock ${lock} (discovered from git-common-dir)`);
			expect(r.ran).toBe(true);
		}
		expect(calls()).toEqual(['bun scripts/verify/metrics.mjs', 'bun scripts/verify/metrics.mjs']);
	});

	it('an explicit lock wins over discovery, and none runs the step without a slot', () => {
		const repo = evidenceCheckout();
		workspaceLock();
		const other = executable(join(ws, 'elsewhere', 'lock'), `#!/bin/sh\necho "$*" >> "${join(ws, 'other-calls')}"\nexec "$@"\n`);
		expect(evidence(repo, { CLEARCASE_BROWSER_LOCK: other }).status).toBe(0);
		expect(readFileSync(join(ws, 'other-calls'), 'utf8').trim()).toBe('bun scripts/verify/metrics.mjs');
		const r = evidence(repo, { CLEARCASE_BROWSER_LOCK: 'none' });
		expect(r.status).toBe(0);
		expect(r.ran).toBe(true);
		expect(calls()).toEqual([]);
	});

	it.each([
		['unset with no workspace lock', {}, /no browser admission/],
		['relative', { CLEARCASE_BROWSER_LOCK: 'orch-bin/browser-lock' }, /CLEARCASE_BROWSER_LOCK="orch-bin\/browser-lock" is neither none/],
		['the retired BROWSER_LOCK', { BROWSER_LOCK: '/bin/env' }, /BROWSER_LOCK is the retired spelling/],
	])('exits 2 before any step: %s', (_n, env, why) => {
		const r = evidence(evidenceCheckout(), env as Record<string, string>);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(why);
		expect(r.stdout).not.toContain('== metrics');
		expect(existsSync(join(ws, 'clearcase', '.local', 'GRS-21'))).toBe(false);
	});
});

describe('the hosted runner and gate:hosted admit through the same contract', () => {
	const KEYS = ['CLEARCASE_BROWSER_LOCK', 'BROWSER_LOCK'] as const;
	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	const setEnv = (env: Partial<Record<(typeof KEYS)[number], string>>) => { for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
	afterEach(() => setEnv(saved as Record<string, string>));
	const port = { app: 43700, canary: 43799 };
	const admissionProblems = (problems: string[]) => problems.filter((p) => /BROWSER_LOCK|browser admission/.test(p));

	it.each([
		['relative', { CLEARCASE_BROWSER_LOCK: 'orch-bin/browser-lock' }, 'CLEARCASE_BROWSER_LOCK="orch-bin/browser-lock" is neither none'],
		['empty', { CLEARCASE_BROWSER_LOCK: '' }, 'CLEARCASE_BROWSER_LOCK="" is neither none'],
		['the retired BROWSER_LOCK', { BROWSER_LOCK: '/bin/env' }, 'BROWSER_LOCK is the retired spelling'],
	])('preflight refuses %s and names the fix', (_n, env, why) => {
		setEnv(env);
		const r = preflight({ port });
		expect(r.ok).toBe(false);
		expect(admissionProblems(r.problems)).toHaveLength(1);
		expect(admissionProblems(r.problems)[0]).toContain(why);
		expect(admissionProblems(r.problems)[0]).toContain('fix: set CLEARCASE_BROWSER_LOCK');
		expect(r.facts.lock).toBe(null);
	});

	it('preflight admits none and an explicit executable, and reports what this checkout discovers when unset', () => {
		setEnv({ CLEARCASE_BROWSER_LOCK: 'none' });
		let r = preflight({ port });
		expect(admissionProblems(r.problems)).toEqual([]);
		expect([r.facts.lock, r.facts.admission]).toEqual([null, 'none']);
		const lock = workspaceLock();
		setEnv({ CLEARCASE_BROWSER_LOCK: lock });
		r = preflight({ port });
		expect(admissionProblems(r.problems)).toEqual([]);
		expect([r.facts.lock, r.facts.admission]).toEqual([lock, 'explicit']);
		setEnv({});
		r = preflight({ port });
		const own = resolveBrowserLock({ env: {}, repo: REPO });
		expect([r.facts.lock, r.facts.admission]).toEqual([own.lock ?? null, own.source ?? null]);
		expect(admissionProblems(r.problems).length).toBe(own.problem ? 1 : 0);
	});

	it('gate:hosted fails preflight on an invalid lock before its refusals or the hosted run start', async () => {
		setEnv({ CLEARCASE_BROWSER_LOCK: 'orch-bin/browser-lock' });
		const started: string[] = [];
		const sha = 'f'.repeat(40);
		const r = await runHostedGate({ head: { sha, dirty: false }, env: {}, repo: REPO, evidenceRoot: join(ws, 'evidence'), scratchRoot: join(ws, 'scratch'), refusals: async () => { started.push('refusals'); return { ok: true }; }, hosted: async () => { started.push('hosted'); return { ok: true, steps: [] }; } });
		expect(started).toEqual([]);
		expect(r.lines.at(-1)).toBe(`GATE FAIL preflight ${sha}`);
		expect(r.lines.join('\n')).toContain('CLEARCASE_BROWSER_LOCK="orch-bin/browser-lock" is neither none');
		expect(existsSync(join(ws, 'evidence'))).toBe(false);
	});

	it('hostedRun refuses a caller that passes no admitted lock, before it creates anything', async () => {
		const evidenceDir = join(ws, 'evidence');
		await expect(hostedRun({ revision: 'r', evidence: evidenceDir, scratch: join(ws, 'scratch'), port, node: { path: process.execPath, version: '0' }, tools: {} })).rejects.toThrow(/pass lock/);
		expect(existsSync(evidenceDir)).toBe(false);
	});
});
