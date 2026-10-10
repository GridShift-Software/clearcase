// The e2e runner (run.mjs): category discovery (a category with views but no suite fails the run; with E2E_ROOT, in
// E2E_ROOT's tree), the suite summary contract (each category suite proves what it ran), the fresh-build refusal
// (exit 2 before any step, also for a build outside <repo>/build or an E2E_ROOT other than this checkout) and its override, the flag only (evidence: false in
// the summary, NOT EVIDENCE in the final line). Synthetic trees, suites and stamps in a temp folder; the runner never
// reaches a browser step here (the override run stops at a missing Chromium).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..', '..', '..');
const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'cc-e2e-run-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s = '') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };

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
	test("the runner checks each category step's summary after the suite ran, and clears an old one first", () => {
		const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
		expect(src).toContain('if (category) rmSync(suiteSummaryFile(dir, category), { force: true });');
		expect(src).toContain('const problems = suiteProblems(dir, category, implementedIn(category));');
		expect(src).toContain("if (problems.length) Object.assign(res, { rc: res.rc === 0 ? 1 : res.rc, summaryProblems: problems });");
	});
});
