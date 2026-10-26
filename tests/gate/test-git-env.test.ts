import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A test run must never write into another repository. A Git hook (or another checkout's script) that runs the tests
// exports GIT_DIR, and every scratch repository a test builds with a bare `git` call would then be built in the
// repository the variable names (the commits land on its branch). The test boundary strips GIT_*: scripts/gate.mjs gives
// each step an environment without it, and tests/setup/strip-git-env.ts, listed by every Vitest config whose tests can call git (WIRED below), deletes it for a direct
// `bun run --bun test` or `vitest --config <config>`.
// Synthetic repositories only.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
// Every tracked Vitest config is in exactly one list. WIRED configs list tests/setup/strip-git-env.ts first (identity inherits
// the root config's setup). NO_GIT configs are explicit private include lists whose test files never call git, with the reason.
const WIRED = [
	'tests/acceptance/CC-23/vitest.config.ts',
	'tests/hosted-foundation/audit-recovery/vitest.config.ts',
	'tests/hosted-foundation/audit/vitest.config.ts',
	'tests/hosted-foundation/case-grant-provisioning/vitest.config.ts',
	'tests/hosted-foundation/hosted-validation/vitest.config.ts',
	'tests/hosted-foundation/identity/vitest.config.ts',
	'tests/hosted-foundation/native-runtime-config/vitest.config.ts',
	'tests/hosted-foundation/native-stager/vitest.config.ts',
	'tests/hosted-foundation/provisioning/vitest.config.ts',
	'tests/hosted-foundation/publication-material/vitest.config.ts',
	'tests/hosted-foundation/recovery-http/vitest.config.ts',
	'tests/hosted-foundation/recovery-native-adapters/vitest.config.ts',
	'tests/hosted-foundation/recovery-native-evidence/vitest.config.ts',
	'tests/hosted-foundation/recovery/vitest.config.ts',
	'tests/hosted-foundation/storage/vitest.config.ts',
	'tests/hosted-foundation/upload-grant/vitest.config.ts',
	'tests/hosted-foundation/user-work/vitest.config.ts',
	'tests/hosted-smoke/case-overview/vitest.config.ts',
	'tests/hosted-smoke/intake/vitest.config.ts',
	'tests/hosted-smoke/native-viewer/vitest.config.ts',
	'tests/hosted-smoke/operator-download/vitest.config.ts',
	'tests/hosted-smoke/operator-workbench/vitest.config.ts',
	'tests/hosted-smoke/pdf-static-assets/vitest.config.ts',
	'tests/hosting-probe/deployment/vitest.config.ts',
	'tests/hosting-probe/identity/vitest.config.ts',
	'tests/native-alpha-journey/vitest.config.ts',
	'tests/parity/vitest.config.ts',
	'tests/publication/hosted/vitest.config.ts',
	'tests/results-review/native/vitest.config.ts',
	'vitest.config.ts',
];
const NO_GIT: readonly (readonly [string, string])[] = [
	['tests/hosted-foundation/artifact-scope/vitest.config.ts', 'static artifact scans over text fixtures'],
	['tests/hosted-foundation/native-runtime-migration/vitest.config.ts', 'runs the migration script with the Bun executable only'],
	['tests/hosted-foundation/native-schema/vitest.config.ts', 'runs the schema script with the Bun executable only'],
	['tests/hosting-probe/deployment/app/vitest.workers.config.mjs', 'Workers pool run only through deployment P5, which supplies an allowlisted environment'],
	['tests/hosting-probe/deployment/native-alpha-controls/vitest.config.ts', 'injected provider data, no git or child process'],
	['tests/hosting-probe/deployment/native-alpha-pipeline/vitest.config.ts', 'synthetic fixtures built and checked with the Bun executable, no git'],
	['tests/hosting-probe/deployment/native-browser-binding/vitest.config.ts', 'synthetic file checks, no git'],
	['tests/hosting-probe/deployment/native-stage-binding/vitest.config.ts', 'real stages on a temp directory, no git'],
	['tests/hosting-probe/deployment/workers-dev-bootstrap-runtime-config/vitest.config.ts', 'synthetic file checks, no git'],
	['tests/hosting-probe/deployment/workers-dev-bootstrap/vitest.config.ts', 'synthetic file checks, no git'],
	['tests/publication/hosted/atomic-d1/vitest.config.ts', 'local D1 transaction tests, no git'],
];
// A test that names git as a command: a quoted 'git' argument, or a shell string starting `git <word>`.
const GIT_CALL = /['"`]git['"`]|['"`]git\s+\S/;
// The Workers config imports a plugin only the deployment probe installs, so its source is read instead of imported.
const loadConfig = async (config: string) => {
	if (!config.endsWith('.mjs')) return (await import(pathToFileURL(join(REPO_ROOT, config)).href)).default;
	const source = readFileSync(join(REPO_ROOT, config), 'utf8');
	const include = /include:\s*\[([^\]]*)\]/.exec(source)?.[1].match(/'[^']+'/g)?.map((q) => q.slice(1, -1)) ?? [];
	return { root: dirname(join(REPO_ROOT, config)), test: { include, setupFiles: source.includes('strip-git-env') ? ['strip-git-env.ts'] : [] } };
};
const configRoot = (cfg: { root?: string; test?: { root?: string } }) => resolve(REPO_ROOT, cfg.test?.root ?? cfg.root ?? '.');
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

	// Each Vitest config whose tests can build a scratch repository wires the strip. The separately inventoried Workers config
	// runs only through deployment P5, whose caller supplies an allowlisted environment.
	it.each(WIRED)('%s runs tests/setup/strip-git-env.ts first', async (config) => {
		const cfg = await loadConfig(config);
		const entries: string[] = cfg.test?.setupFiles ?? [];
		// Relative entries resolve against the config's root (the repository root unless it names another); nested configs use absolute entries.
		const resolved = entries.map((e) => resolve(configRoot(cfg), e));
		expect(resolved[0], `${config} test.setupFiles`).toBe(join(REPO_ROOT, 'tests', 'setup', 'strip-git-env.ts'));
	});

	it('the lists above are every tracked Vitest config, each in exactly one of them', () => {
		const tracked = spawnSync('git', ['ls-files', '*vitest.config.*', '*vitest.workspace.*', '*vitest.*.config.*'], { cwd: REPO_ROOT, encoding: 'utf8', env: clean() }).stdout.split('\n').filter(Boolean).sort();
		const exempt = NO_GIT.map(([config]) => config);
		expect([...WIRED].sort().filter((c) => exempt.includes(c)), 'configs listed as both wired and exempt').toEqual([]);
		expect([...WIRED, ...exempt].sort()).toEqual(tracked);
		expect(tracked).toHaveLength(41);
	});

	// An exempt config is not a free pass: it must not wire the strip (otherwise it belongs in WIRED), and no test file it
	// includes may call `git` (a bare call would build its scratch repository in the repository an inherited GIT_DIR names).
	describe.each(NO_GIT)('%s (exempt: %s)', (config) => {
		it('does not wire the strip, so the list stays exact', async () => {
			const cfg = await loadConfig(config);
			expect(((cfg.test?.setupFiles ?? []) as string[]).map((e) => basename(e)), `${config} test.setupFiles`).not.toContain('strip-git-env.ts');
		});

		it('includes only test files that never call git', async () => {
			const cfg = await loadConfig(config);
			const root = configRoot(cfg);
			const prefix = relative(REPO_ROOT, root).split(sep).join('/');
			const files = new Set<string>();
			for (const pattern of cfg.test?.include as string[]) {
				const spec = `:(glob)${prefix ? `${prefix}/` : ''}${pattern}`;
				const found = spawnSync('git', ['ls-files', '--', spec], { cwd: REPO_ROOT, encoding: 'utf8', env: clean() }).stdout.split('\n').filter(Boolean);
				expect(found, `${config} include ${pattern} matches no tracked file`).not.toEqual([]);
				for (const f of found) files.add(f);
			}
			const callers = [...files].filter((f) => GIT_CALL.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
			expect(callers, `${config} includes tests that call git; wire the strip in the config and move it to WIRED`).toEqual([]);
		});
	});

	it('the exempt scan sees a bare git call, so an empty result means no caller', () => {
		for (const call of ["spawnSync('git', ['init'])", 'spawnSync("git", args)', "execFileSync('git', ['-C', d])", 'execSync(`git init -q`)', "run('git init')"]) expect(GIT_CALL.test(call), call).toBe(true);
		for (const text of ["const x = 'digit';", 'a legit comment', "import { gitEnv } from './gate'"]) expect(GIT_CALL.test(text), text).toBe(false);
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
