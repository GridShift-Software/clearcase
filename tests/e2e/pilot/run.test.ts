// The e2e runner (run.mjs): category discovery (a category with views but no suite fails the run; with E2E_ROOT, in
// E2E_ROOT's tree), the suite summary contract (each category suite proves what it ran), the fresh-build refusal
// (exit 2 before any step, also for a build outside <repo>/build, an E2E_ROOT other than this checkout or a copy of the
// runner that is not git's top level) and its override, the flag only (evidence: false in
// the summary, NOT EVIDENCE in the final line); a development knob or a suite run by file name that the reviewed
// commit does not hold (one a committed .gitignore hides) makes a run non-evidence. Synthetic trees, suites and stamps
// in a temp folder; the runner never reaches a browser step here (it stops at a missing Chromium, after writing its
// evidence record).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..', '..', '..');
const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'cc-e2e-run-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s = '') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
/** An mtime long before any index write (seconds since the epoch), so git trusts the index entry's stat data. */
const OLD_MTIME = 86_400;
/** The development knobs, a value for each and what the evidence note says it does (an empty size list is one size of 0 MiB). */
const DEV: Record<string, [string, string]> = { E2E_ONLY: ['S9,S10', 'runs only the listed durability scenarios'], E2E_STOP_AFTER: ['S3', 'stops the browser suite early'], E2E_LATENCY_SIZES_MIB: ['', 'changes the durability latency file sizes'], CLEARCASE_E2E_TMP: ['/dev/shm/e2e', 'moves the durability files off the disk-backed default folder'], CLASSES_ONLY: ['narrow', 'runs only the listed UI classes'], CLASSES_TARGET: ['filings', 'runs the UI class scenarios of the targets matching a pattern only'] };

describe('category discovery', () => {
	test('suites and views per category; views without a suite are listed as missing', async () => {
		const { discoverCategories } = await import(join(HERE, 'run.mjs'));
		const e2eDir = join(root, 'e2e'), routesDir = join(root, 'routes');
		put(join(e2eDir, 'evidence', 'suite.mjs'));
		put(join(e2eDir, 'system', 'suite.mjs'));
		put(join(routesDir, 'evidence', 'search', '+page.svelte'));
		put(join(routesDir, 'registers', 'deadlines_tab', '+page.svelte'));
		mkdirSync(join(routesDir, 'analysis', 'empty'), { recursive: true });
		put(join(routesDir, '[category]', '[view]', '+page.svelte'));
		expect(discoverCategories({ e2eDir, routesDir })).toEqual({ suites: ['evidence', 'system'], views: ['evidence', 'registers'], missing: ['registers'] });
		// the committed tree: no owner routes, so nothing is missing
		expect(discoverCategories().missing).toEqual([]);
	});
	test("with E2E_ROOT set, categories and suites are read from E2E_ROOT's tree", () => {
		const app = join(root, 'e2e-root');
		put(join(app, 'src', 'routes', 'v', '[vid]', 'analysis', 'timeline', '+page.svelte'));
		put(join(app, 'tests', 'e2e', 'system', 'suite.mjs'));
		const r = spawnSync(BUN, ['-e', `const m = await import(${JSON.stringify(join(HERE, 'run.mjs'))}); console.log(JSON.stringify({ d: m.discoverCategories(), s: m.categorySteps().map((x) => x[2]) }));`], { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, E2E_ROOT: app } });
		expect(r.status, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ d: { suites: ['system'], views: ['analysis'], missing: ['analysis'] }, s: ['system'] });
	});
	test('the runner prints the discovered categories and fails each missing suite with its own result line', () => {
		const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
		expect(src).toContain("console.log(`test:e2e: categories with a suite: ${cats.suites.join(', ') || 'none'}; with views: ${cats.views.join(', ') || 'none'}`);");
		expect(src).toContain('name: `category ${c} has views but no suite`, rc: 1');
		expect(src).toMatch(/results\.every\(\(r\) => r\.rc === 0\) && noSuite\.length === 0/);
	});
});

describe('fresh-build evidence', () => {
	const build = (revision: string, dirty = false) => {
		const d = mkdtempSync(join(root, 'build-'));
		put(join(d, 'handler.js'));
		put(join(d, 'clearcase-build.json'), JSON.stringify({ revision, dirty, buildId: 'synthetic' }));
		return d;
	};
	const run = (buildDir: string, args: string[] = [], env: Record<string, string> = {}) => {
		const out = mkdtempSync(join(root, 'out-'));
		const r = spawnSync(BUN, [join(HERE, 'run.mjs'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, E2E_BUILD_DIR: buildDir, CLEARCASE_E2E_OUT: out, CLEARCASE_CHROMIUM: join(root, 'no-chromium'), ...env } });
		return { ...r, summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) };
	};
	test('a build of another revision is refused with exit 2 before any step', () => {
		const r = run(build('0000000000000000000000000000000000000000'));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/test:e2e: stale build \(the build is of 000000000000, not HEAD/);
		expect(r.stderr).toMatch(/then run `bun run --bun build` in the repository itself, then rerun \(or pass --allow-stale-build for a non-evidence run\)/);
		expect(r.summary).toMatchObject({ ok: false, evidence: false, results: [] });
	});
	test("a build stamped with HEAD but outside <repo>/build (E2E_BUILD_DIR, a copy) is refused", () => {
		const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
		const d = build(head);
		const r = run(d);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`the build is not ${join(REPO, 'build')}`);
	});
	test('an E2E_ROOT other than this checkout is refused (its server entry, suites and routes are unverified); so is verify:pilot:v5', () => {
		const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
		const copy = mkdtempSync(join(root, 'copy-'));
		const reason = `the app tree under test is ${copy}, not ${REPO}`;
		const r = run(build(head), [], { E2E_ROOT: copy });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(reason);
		expect(r.summary).toMatchObject({ ok: false, evidence: false, results: [] });
		const v5 = spawnSync(BUN, [join(HERE, 'v5-lanes.mjs')], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, E2E_ROOT: copy, E2E_BUILD_DIR: build(head), CLEARCASE_REPORT_DIR: mkdtempSync(join(root, 'v5-')) } });
		expect(v5.status).toBe(2);
		expect(v5.stderr).toMatch(/^verify:pilot:v5: stale build \(/);
		expect(v5.stderr).toContain(reason);
		// the runners pass the tree under test to the guard
		expect(readFileSync(join(HERE, 'run.mjs'), 'utf8')).toContain('freshness(root, build, { buildDir, appRoot })');
		expect(readFileSync(join(HERE, 'v5-lanes.mjs'), 'utf8').match(/freshness\(REPO, b\.stamp, \{ buildDir: b\.buildDir, appRoot: b\.root \}\)/g)).toHaveLength(2);
	});
	test("a copy of the runner inside another checkout is refused: it is not git's top level (the reviewer's copy route)", () => {
		// a clean synthetic checkout whose ignored .local/copy holds a modified copy of this runner and a build stamped
		// with the checkout's HEAD: git, asked in the copy, would answer for the clean checkout around it
		const repo = mkdtempSync(join(root, 'outer-'));
		const g = (...a: string[]) => { const x = spawnSync('git', ['-C', repo, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr); return x.stdout.trim(); };
		g('init', '-q');
		put(join(repo, '.gitignore'), '.local/\n');
		put(join(repo, 'a.txt'), 'one\n');
		g('add', '.');
		g('commit', '-q', '-m', 'synthetic');
		const copy = join(repo, '.local', 'copy');
		cpSync(HERE, join(copy, 'tests', 'e2e', 'pilot'), { recursive: true });
		put(join(copy, 'tests', 'e2e', 'pilot', 'suite.mjs'), `${readFileSync(join(HERE, 'suite.mjs'), 'utf8')}\n// modified in the copy\n`);
		put(join(copy, 'build', 'handler.js'));
		put(join(copy, 'build', 'clearcase-build.json'), JSON.stringify({ revision: g('rev-parse', 'HEAD'), dirty: false, buildId: 'synthetic' }));
		const out = mkdtempSync(join(root, 'out-'));
		const env: NodeJS.ProcessEnv = { ...process.env, CLEARCASE_E2E_OUT: out, CLEARCASE_CHROMIUM: join(root, 'no-chromium') };
		for (const k of ['E2E_ROOT', 'E2E_BUILD_DIR']) delete env[k];
		const r = spawnSync(BUN, [join(copy, 'tests', 'e2e', 'pilot', 'run.mjs')], { cwd: copy, encoding: 'utf8', timeout: 60_000, env });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${copy} is not the top level of its git checkout: git answers for ${repo}`);
		expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))).toMatchObject({ ok: false, evidence: false, freshBuild: { fresh: false } });
	});
	test('--allow-stale-build runs it: evidence: false in the summary and NOT EVIDENCE in the final line', () => {
		const r = run(build('0000000000000000000000000000000000000000', true), ['--allow-stale-build']);
		// past the refusal: it stops only at the missing Chromium (a prerequisite), never reaching a step
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/missing prerequisites: chromium/);
		expect(r.summary.evidence).toBe(false);
		expect(r.summary.freshBuild).toMatchObject({ fresh: false, allowStaleBuild: true, buildDirty: true });
		expect(r.summary.evidenceNote).toMatch(/^NOT release evidence \(--allow-stale-build\): the build is of 000000000000, not HEAD .*; the build was made from a tree with modified or untracked files/);
		expect(r.stdout.trim().split('\n').at(-1)).toMatch(/^test:e2e: FAIL — NOT EVIDENCE \(NOT release evidence \(--allow-stale-build\)/);
	});
	test('a development knob, or a suite the reviewed commit does not hold, makes a run non-evidence', () => {
		// a clean synthetic checkout holding this runner, with a build stamped with its HEAD and no Chromium: the runner
		// stops at the missing prerequisite, but writes the evidence record a full run would
		const repo = mkdtempSync(join(root, 'knobs-'));
		const g = (...a: string[]) => { const x = spawnSync('git', ['-C', repo, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr); return x.stdout.trim(); };
		cpSync(HERE, join(repo, 'tests', 'e2e', 'pilot'), { recursive: true });
		cpSync(join(HERE, '..', 'classes'), join(repo, 'tests', 'e2e', 'classes'), { recursive: true });
		for (const f of ['view-registry.ts', 'overview-slots.ts']) cpSync(join(REPO, 'src', 'lib', 'components', f), join(repo, 'src', 'lib', 'components', f));
		put(join(repo, '.gitignore'), readFileSync(join(REPO, '.gitignore'), 'utf8'));
		const commit = (msg: string) => {
			g('add', '-A');
			g('commit', '-q', '-m', msg);
			put(join(repo, 'build', 'handler.js'));
			put(join(repo, 'build', 'clearcase-build.json'), JSON.stringify({ revision: g('rev-parse', 'HEAD'), dirty: false, buildId: 'synthetic' }));
			expect(g('status', '--porcelain')).toBe('');
		};
		g('init', '-q');
		commit('synthetic');
		const env: NodeJS.ProcessEnv = { ...process.env, CLEARCASE_CHROMIUM: join(root, 'no-chromium') };
		for (const k of ['E2E_ROOT', 'E2E_BUILD_DIR', ...Object.keys(DEV), ...Object.keys(env).filter((k) => k.startsWith('GIT_'))]) delete env[k];
		const summary = (extra: Record<string, string> = {}) => {
			const out = mkdtempSync(join(root, 'out-'));
			const r = spawnSync(BUN, [join(repo, 'tests', 'e2e', 'pilot', 'run.mjs')], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: { ...env, CLEARCASE_E2E_OUT: out, ...extra } });
			expect(r.stderr).toMatch(/missing prerequisites: chromium/);
			return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
		};
		// the control: a fresh build of the clean checkout is evidence
		expect(summary()).toMatchObject({ evidence: true, freshBuild: { fresh: true } });
		for (const [k, v] of Object.entries(DEV)) expect(summary({ [k]: v[0] })).toMatchObject({ evidence: false, freshBuild: { fresh: true }, evidenceNote: `NOT release evidence: ${k}=${v[0]} ${v[1]}` });
		// a committed tests/e2e/evidence/.gitignore hides that category's suite: git status is clean, the runner finds the
		// suite and would run it, and the run is not evidence
		put(join(repo, 'tests', 'e2e', 'evidence', '.gitignore'), 'suite.mjs\n');
		commit('a committed rule hides the evidence suite');
		put(join(repo, 'tests', 'e2e', 'evidence', 'suite.mjs'), '// an unreviewed suite\n');
		expect(g('status', '--porcelain')).toBe('');
		expect(summary()).toMatchObject({ categories: { suites: ['evidence'] }, evidence: false, freshBuild: { fresh: true }, evidenceNote: 'NOT release evidence: suites run by file name that the reviewed commit does not hold: tests/e2e/evidence/suite.mjs (ignored)' });
		// a committed suite whose edit a clean filter hid from git's index (git status clean): its bytes are not HEAD's
		const rel = 'tests/e2e/system/suite.mjs';
		put(join(repo, rel), '// the reviewed suite\n');
		commit('a committed system suite');
		put(join(repo, rel), '// an unreviewed edit\n');
		utimesSync(join(repo, rel), OLD_MTIME, OLD_MTIME);
		put(join(repo, '.git', 'info', 'attributes'), `${rel} filter=hide\n`);
		g('config', 'filter.hide.clean', `sh -c 'cat >/dev/null; git cat-file blob HEAD:${rel}'`);
		g('add', rel);
		rmSync(join(repo, '.git', 'info', 'attributes'));
		g('config', '--unset', 'filter.hide.clean');
		expect(g('status', '--porcelain')).toBe('');
		expect(summary()).toMatchObject({ categories: { suites: ['evidence', 'system'] }, evidence: false, freshBuild: { fresh: true }, evidenceNote: `NOT release evidence: suites run by file name that the reviewed commit does not hold: tests/e2e/evidence/suite.mjs (ignored), ${rel} (its bytes are not HEAD's)` });
	});
	test('an exported CLEARCASE_ALLOW_STALE_BUILD=1 no longer overrides the refusal', () => {
		const r = run(build('0000000000000000000000000000000000000000', true), [], { CLEARCASE_ALLOW_STALE_BUILD: '1' });
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/test:e2e: stale build/);
	});
});

describe('the suite summary contract', () => {
	/** Run a synthetic category suite as the runner does (CLEARCASE_E2E_OUT set), then check what it wrote. */
	const suite = (name: string, body: string, implemented: string[]) => {
		const out = mkdtempSync(join(root, 'suite-out-'));
		const file = join(root, 'suites', name, 'suite.mjs');
		put(file, `import { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst dir = join(process.env.CLEARCASE_E2E_OUT, 'registers');\nmkdirSync(dir, { recursive: true });\n${body}\n`);
		const r = spawnSync(BUN, [file], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLEARCASE_E2E_OUT: out } });
		expect(r.status, r.stderr).toBe(0);
		return import(join(HERE, 'run.mjs')).then((m) => m.suiteProblems(out, 'registers', implemented) as string[]);
	};
	const write = (scenarios: unknown) => `writeFileSync(join(dir, 'summary.json'), JSON.stringify(${JSON.stringify({ scenarios })}));`;
	test('a suite that proves each implemented view passed is accepted', async () => {
		expect(await suite('good', write([{ id: 'S1', view: 'deadlines_tab', pass: true }, { id: 'S2', view: 'timesheet_tab', pass: true }]), ['deadlines_tab', 'timesheet_tab'])).toEqual([]);
	});
	test('a suite that exits 0 without a summary fails, naming the file to write', async () => {
		const p = await suite('silent', 'process.exit(0);', []);
		expect(p).toEqual([expect.stringMatching(/^no suite summary: tests\/e2e\/registers\/suite\.mjs must write .*registers\/summary\.json as \{ "scenarios": \[ \{ "id", "view", "pass" \} \] \}$/)]);
	});
	test('an empty list, a failed scenario and an implemented view in no scenario each fail', async () => {
		expect((await suite('empty', write([]), [])).join()).toMatch(/lists no scenarios/);
		expect((await suite('failed', write([{ id: 'S1', view: 'deadlines_tab', pass: false }]), ['deadlines_tab'])).join()).toMatch(/scenario\(s\) not passed: S1/);
		expect((await suite('uncovered', write([{ id: 'S1', view: 'deadlines_tab', pass: true }]), ['deadlines_tab', 'timesheet_tab'])).join()).toMatch(/implemented view\(s\) in no scenario: timesheet_tab: add a scenario/);
		expect((await suite('shape', write([{ id: 'S1', pass: true }]), [])).join()).toMatch(/lack a string id, a string view or a boolean pass/);
		expect((await suite('garbage', "writeFileSync(join(dir, 'summary.json'), '{');", [])).join()).toMatch(/does not parse/);
	});
	test('a suite that groups scenarios in classes fails when a class it ran has no passing scenario', async () => {
		const ok = [{ id: 'a:1', view: 'v', pass: true }];
		const withClasses = (byClass: unknown, only?: string[]) => `writeFileSync(join(dir, 'summary.json'), JSON.stringify(${JSON.stringify({ scenarios: ok, byClass, ...(only ? { only } : {}) })}));`;
		expect(await suite('classes-ok', withClasses({ a: { pass: 1 }, b: { pass: 3 } }), ['v'])).toEqual([]);
		expect((await suite('classes-empty', withClasses({ a: { pass: 1 }, b: { pass: 0 } }), ['v'])).join()).toMatch(/class\(es\) with no passing scenario: b:/);
		// a run restricted to some classes (a dev run) is judged on those
		expect(await suite('classes-only', withClasses({ a: { pass: 1 }, b: { pass: 0 } }, ['a']), ['v'])).toEqual([]);
	});
	test("the runner checks each category step's summary after the suite ran, and clears an old one first", () => {
		const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
		expect(src).toContain('if (category) rmSync(suiteSummaryFile(dir, category), { force: true });');
		expect(src).toContain('const problems = suiteProblems(dir, category, implementedIn(category));');
		expect(src).toContain("if (problems.length) Object.assign(res, { rc: res.rc === 0 ? 1 : res.rc, summaryProblems: problems });");
	});
});

describe('a step that timed out or aborted is not evidence (fail fast)', () => {
	test("stepAbort names a timeout and an aborted suite's record, and nothing for a finished or missing one", async () => {
		const { STEP_TIMEOUT_MS, stepAbort } = await import(join(HERE, 'run.mjs'));
		const out = mkdtempSync(join(root, 'abort-'));
		writeFileSync(join(out, 'suite.json'), JSON.stringify({ ok: false, aborted: { step: 'scenario S1', cause: 'Chromium exited (signal SIGTRAP)', kind: 'browser' } }));
		writeFileSync(join(out, 'durability.json'), JSON.stringify({ ok: true }));
		expect(stepAbort(out, { name: 'browser suite (offline)' })).toBe('browser suite (offline): run aborted in scenario S1: Chromium exited (signal SIGTRAP)');
		expect(stepAbort(out, { name: 'durability suite (offline)' })).toBeNull();
		expect(stepAbort(out, { name: 'loopback bind check (host namespace)' })).toBeNull(); // no record written
		expect(stepAbort(out, { name: 'evidence suite (offline)' })).toBeNull(); // a category suite has none
		expect(stepAbort(out, { name: 'durability suite (offline)', timedOut: true })).toBe(`durability suite (offline): no result within ${STEP_TIMEOUT_MS / 1000} s (timeout); stopped`);
	});
	test('the runner bounds each step, clears its record first and passes every abort to the evidence record', () => {
		const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
		expect(src).toContain('for (const f of Object.values(STEP_RECORDS)) rmSync(join(dir, f), { force: true });');
		expect(src).toContain("timeout: STEP_TIMEOUT_MS, killSignal: 'SIGTERM' });");
		expect(src).toContain('const evidence = evidenceRecord(fresh, allowed, [...e2eNonEvidence(process.env, steps.map(([, [, args]]) => args.at(-1)), read), ...results.map((r) => stepAbort(dir, r)).filter(Boolean)]);');
	});
});
