// The M2 base: the shared files parallel M2 owners would otherwise all edit discover each owner's own file instead.
// `bun run --bun measure --ticket CC-NN` runs scripts/measure/ccNN.mjs when it exists (CC-02 and CC-03 unchanged), and
// its record is evidence only when the reviewed commit holds that runner;
// `test:e2e` runs tests/e2e/<category>/suite.mjs offline after the pilot suites; the root vitest config includes the
// owners' test paths. Synthetic files in temp copies only: nothing here is written into the repository.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'm2-base-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const echo = (name: string) => `console.log(JSON.stringify({ runner: ${JSON.stringify(name)}, args: process.argv.slice(2) }));\nconsole.error('evidence=' + process.env.CLEARCASE_BUILD_EVIDENCE);\nprocess.exit(${name === 'cc99' ? 7 : 0});\n`;
const git = (repo: string, ...args: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).stdout.trim();

describe('measure dispatcher', () => {
	// a temp copy of the dispatcher with synthetic runners beside it
	const copy = join(root, 'measure');
	put(join(copy, 'scripts', 'case-package', 'measure.ts'), echo('case-package'));
	put(join(copy, 'scripts', 'measure', 'cc03.mjs'), echo('cc03'));
	put(join(copy, 'scripts', 'measure', 'cc02.mjs'), echo('cc02 must not replace case-package'));
	put(join(copy, 'scripts', 'measure', 'cc99.mjs'), echo('cc99'));
	put(join(copy, 'scripts', 'measure', 'cc4.mjs'), echo('cc4'));
	put(join(copy, 'scripts', 'measure', 'cc100.mjs'), echo('cc100'));
	copyFileSync(join(REPO, 'scripts', 'measure', 'index.ts'), join(copy, 'scripts', 'measure', 'index.ts'));
	copyFileSync(join(REPO, 'scripts', 'browser-lock.mjs'), join(copy, 'scripts', 'browser-lock.mjs'));
	put(join(copy, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'), readFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'), 'utf8'));
	// the copy is no git checkout, so its build is never fresh: the dispatch tests run with the documented override
	const run = (env: Record<string, string>, args: string[]) => spawnSync(BUN, [join(copy, 'scripts', 'measure', 'index.ts'), ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLEARCASE_REPORT_DIR: join(copy, 'report'), ...env } });
	const measure = (...args: string[]) => run({}, [...args, '--allow-stale-build']);

	test('CC-NN runs scripts/measure/ccNN.mjs with every argument, and returns its exit code', () => {
		const r = measure('--ticket', 'CC-99', '--baseline', 'a', '--candidate', 'b');
		expect(r.status).toBe(7);
		expect(JSON.parse(r.stdout)).toEqual({ runner: 'cc99', args: ['--ticket', 'CC-99', '--baseline', 'a', '--candidate', 'b'] });
		expect(JSON.parse(measure('--ticket=CC-99').stdout).args).toEqual(['--ticket=CC-99']);
	});
	test('CC-02 and CC-03 dispatch as before; a ccNN.mjs never replaces them', () => {
		expect(JSON.parse(measure('--ticket', 'CC-02', '--x').stdout)).toEqual({ runner: 'case-package', args: ['--ticket', 'CC-02', '--x'] });
		expect(JSON.parse(measure('--ticket', 'CC-03', '--x').stdout)).toEqual({ runner: 'cc03', args: ['--ticket', 'CC-03', '--x'] });
		const src = readFileSync(join(REPO, 'scripts', 'measure', 'index.ts'), 'utf8');
		expect(src).toContain(`'CC-02': 'scripts/case-package/measure.ts',\n\t'CC-03': 'scripts/measure/cc03.mjs',`);
	});
	test('an unknown ticket, or a file not named cc plus two digits, is a usage error listing the tickets', () => {
		for (const t of ['CC-98', 'CC-4', 'CC-100', '../cc99']) {
			const r = measure('--ticket', t);
			expect(r.status, t).toBe(2);
			expect(r.stderr).toMatch(new RegExp(`--ticket CC-02\\|CC-03\\|CC-99 .*\\(unknown ticket ${t.replace('.', '\\.')}\\)`));
		}
		expect(measure().status).toBe(2);
	});

	describe('fresh-build evidence', () => {
		const evidence = (t = 'CC-99') => JSON.parse(readFileSync(join(copy, 'report', 'measure', `build-evidence-${t}.json`), 'utf8'));
		test('a stale revision under test is refused with exit 2 before the runner starts', () => {
			const r = run({}, ['--ticket', 'CC-99', '--candidate', 'HEAD']);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe('');
			expect(r.stderr).toMatch(/measure: stale build \(.*not a git checkout/);
			expect(evidence()).toMatchObject({ ticket: 'CC-99', evidence: false, freshBuild: { fresh: false, allowStaleBuild: false } });
		});
		test('--allow-stale-build runs it with evidence: false, and the runner never sees the flag', () => {
			const r = run({}, ['--ticket', 'CC-99', '--allow-stale-build', '--candidate', 'HEAD']);
			expect(r.status).toBe(7);
			expect(JSON.parse(r.stdout).args).toEqual(['--ticket', 'CC-99', '--candidate', 'HEAD']);
			expect(r.stderr).toMatch(/evidence=false/);
			expect(evidence()).toMatchObject({ evidence: false, underTest: '--candidate HEAD', freshBuild: { allowStaleBuild: true } });
			expect(evidence().evidenceNote).toMatch(/^NOT release evidence/);
			expect(r.stderr.trim().split('\n').at(-1)).toMatch(/^measure: CC-99 exit 7 — NOT EVIDENCE \(NOT release evidence/);
			// the environment form is gone: an exported CLEARCASE_ALLOW_STALE_BUILD=1 is still refused
			expect(run({ CLEARCASE_ALLOW_STALE_BUILD: '1' }, ['--ticket', 'CC-99', '--candidate', 'HEAD']).status).toBe(2);
		});
		test("in a clean checkout, --candidate HEAD or a build stamped with HEAD is fresh; another revision or a modified tracked file is not", () => {
			const repo = join(root, 'measure-git');
			put(join(repo, 'scripts', 'measure', 'cc99.mjs'), echo('cc99'));
			put(join(repo, 'scripts', 'measure', 'index.ts'), readFileSync(join(REPO, 'scripts', 'measure', 'index.ts'), 'utf8'));
			put(join(repo, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'), readFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'), 'utf8'));
			put(join(repo, 'scripts', 'browser-lock.mjs'), readFileSync(join(REPO, 'scripts', 'browser-lock.mjs'), 'utf8'));
			put(join(repo, '.gitignore'), 'build/\nreport/\n');
			git(repo, 'init', '-q');
			git(repo, 'add', '.');
			git(repo, 'commit', '-q', '-m', 'synthetic');
			const first = git(repo, 'rev-parse', 'HEAD');
			const go = (...args: string[]) => spawnSync(BUN, [join(repo, 'scripts', 'measure', 'index.ts'), '--ticket', 'CC-99', ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLEARCASE_REPORT_DIR: join(repo, 'report') } });
			const cand = go('--candidate', 'HEAD');
			expect(cand.status, cand.stderr).toBe(7);
			expect(cand.stderr).toMatch(/evidence=true/);
			put(join(repo, 'build', 'clearcase-build.json'), JSON.stringify({ revision: first, dirty: false }));
			expect(go().status).toBe(7);
			put(join(repo, 'build', 'clearcase-build.json'), JSON.stringify({ revision: first, dirty: true }));
			expect(go().status).toBe(2);
			put(join(repo, 'build', 'clearcase-build.json'), JSON.stringify({ revision: '0'.repeat(40), dirty: false }));
			expect(go().status).toBe(2);
			put(join(repo, 'build', 'clearcase-build.json'), JSON.stringify({ revision: first, dirty: false }));
			writeFileSync(join(repo, 'scripts', 'measure', 'cc99.mjs'), echo('cc99') + '// modified\n');
			const dirty = go();
			expect(dirty.status).toBe(2);
			expect(dirty.stderr).toMatch(/files are modified or untracked: scripts\/measure\/cc99\.mjs/);
			writeFileSync(join(repo, 'scripts', 'measure', 'cc99.mjs'), echo('cc99'));
			// a runner a committed .gitignore hides: git status is clean and the build fresh, but the record is not evidence
			put(join(repo, 'scripts', 'measure', '.gitignore'), 'cc98.mjs\n');
			git(repo, 'add', '.');
			git(repo, 'commit', '-q', '-m', 'a committed rule hides cc98.mjs');
			put(join(repo, 'scripts', 'measure', 'cc98.mjs'), echo('cc98'));
			expect(git(repo, 'status', '--porcelain')).toBe('');
			const hidden = spawnSync(BUN, [join(repo, 'scripts', 'measure', 'index.ts'), '--ticket', 'CC-98', '--candidate', 'HEAD'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLEARCASE_REPORT_DIR: join(repo, 'report') } });
			expect(hidden.status, hidden.stderr).toBe(0);
			expect(hidden.stderr).toMatch(/evidence=false/);
			expect(JSON.parse(readFileSync(join(repo, 'report', 'measure', 'build-evidence-CC-98.json'), 'utf8'))).toMatchObject({ evidence: false, freshBuild: { fresh: true }, evidenceNote: 'NOT release evidence: the measure runner that the reviewed commit does not hold: scripts/measure/cc98.mjs (ignored)' });
			// a committed runner whose edit a clean filter hid from git's index (git status clean): its bytes are not HEAD's
			const rel = 'scripts/measure/cc99.mjs';
			writeFileSync(join(repo, rel), echo('cc99') + '// an unreviewed edit\n');
			utimesSync(join(repo, rel), 86_400, 86_400); // an mtime long before the index write, in seconds
			put(join(repo, '.git', 'info', 'attributes'), `${rel} filter=hide\n`);
			git(repo, 'config', 'filter.hide.clean', `sh -c 'cat >/dev/null; git cat-file blob HEAD:${rel}'`);
			git(repo, 'add', rel);
			rmSync(join(repo, '.git', 'info', 'attributes'));
			git(repo, 'config', '--unset', 'filter.hide.clean');
			expect(git(repo, 'status', '--porcelain')).toBe('');
			const poisoned = go('--candidate', 'HEAD');
			expect(poisoned.status, poisoned.stderr).toBe(7);
			expect(poisoned.stderr).toMatch(/evidence=false/);
			expect(JSON.parse(readFileSync(join(repo, 'report', 'measure', 'build-evidence-CC-99.json'), 'utf8'))).toMatchObject({ evidence: false, freshBuild: { fresh: true }, evidenceNote: `NOT release evidence: the measure runner that the reviewed commit does not hold: ${rel} (its bytes are not HEAD's)` });
		});
	});
});

describe('browser e2e categories', () => {
	const e2e = join(root, 'e2e');
	put(join(e2e, 'system', 'suite.mjs'), '');
	put(join(e2e, 'evidence', 'suite.mjs'), '');
	put(join(e2e, 'quantum', 'other.mjs'), '');
	put(join(e2e, 'unknown', 'suite.mjs'), '');
	const load = () => import(join(REPO, 'tests', 'e2e', 'pilot', 'run.mjs'));

	test('each existing category suite is one offline step, in category order; others are skipped silently', async () => {
		const { categorySteps, CATEGORIES, offlineStep } = await load();
		expect(CATEGORIES).toEqual(['evidence', 'analysis', 'quantum', 'registers', 'litigation', 'bundles', 'system']);
		const steps = categorySteps(e2e);
		expect(steps.map(([name]: [string]) => name)).toEqual(['evidence suite (offline)', 'system suite (offline)']);
		expect(steps[0][1]).toEqual(offlineStep(join(e2e, 'evidence', 'suite.mjs')));
		expect(steps[0][1][0]).toBe('unshare');
		expect(steps[0][1][1]).toEqual(['-rn', 'env', `OUTER_UID=${process.getuid!()}`, `OUTER_GID=${process.getgid!()}`, join(REPO, 'tests', 'e2e', 'pilot', 'offline.sh'), process.execPath, join(e2e, 'evidence', 'suite.mjs')]);
		expect(categorySteps(join(root, 'none'))).toEqual([]);
	});
	test('the runner runs them after the pilot suites, through the same offline wrapper, each reported as its own step', () => {
		const src = readFileSync(join(REPO, 'tests', 'e2e', 'pilot', 'run.mjs'), 'utf8');
		expect(src).toMatch(/\['loopback bind check \(host namespace\)', \[process\.execPath, \[join\(here, 'netcheck\.mjs'\)\]\]\],\n\t\t\.\.\.categorySteps\(\),\n\t\];/);
		expect(src).toMatch(/const offline = \(file\) => offlineStep\(join\(here, file\)\);/);
		expect(src).toMatch(/const res = \{ name, rc: r\.status, ms: Date\.now\(\) - t0 \};/);
	});
});

describe('vitest includes', () => {
	// The hard-coded file counts below make every sprint PR that adds a test file collide. CI-lite sets CLEARCASE_SPRINT=1 and the
	// dev gate does not, so the counts still guard dev (docs/sprint/tickets/01-sprint-operating-kit.md).
	const counted = process.env.CLEARCASE_SPRINT === '1' ? test.skip : test;
	counted("the owners' test paths are collected, other paths are not", () => {
		const tree = join(root, 'vitest');
		const files = ['tests/evidence/a/x.test.ts', 'tests/system/x.test.ts', 'tests/calculations/x.test.ts', 'src/lib/user-work/backup/x.test.ts', 'src/lib/views/registers/x.test.ts', 'src/lib/bundles/x.test.ts', 'tests/parity/x.test.ts', 'src/routes/v/[vid]/registers/deadlines_tab/ics.test.ts', 'tests/e2e/pilot/lib/x.test.ts', 'src/lib/other/x.test.ts', 'tests/e2e/evidence/x.test.ts', 'tests/acceptance/x.test.ts'];
		for (const f of files) put(join(tree, f), "import { test } from 'vitest';\ntest('synthetic', () => {});\n");
		const r = spawnSync(BUN, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly', '--root', tree, '--config', join(REPO, 'vitest.config.ts')], { encoding: 'utf8', timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		// vitest labels each file with its project; the viewer project's root is the repository, not --root
		const listed = r.stdout.trim().split('\n').sort(), prefixed = (name: string) => listed.filter((l) => l.startsWith(`[${name}] `)).map((l) => l.slice(name.length + 3));
		expect(prefixed('root').sort()).toEqual(files.slice(0, 9).sort());
		const viewer = prefixed('native-viewer').map((f) => resolve(tree, f)).sort(), viewerDir = join(REPO, 'tests', 'hosted-smoke', 'native-viewer');
		expect(viewer).toEqual(readdirSync(viewerDir).filter((f) => f.endsWith('.test.ts')).map((f) => join(viewerDir, f)).sort());
		expect(viewer).toContain(join(viewerDir, 'intake-page.test.ts'));
		expect(viewer).toContain(join(viewerDir, 'pdf-assets.test.ts'));
		expect(viewer).toContain(join(viewerDir, 'intake-set-page.test.ts'));
		expect(viewer).toContain(join(viewerDir, '08-page-count.test.ts'));
		expect(viewer).toContain(join(viewerDir, '280-note-delete.test.ts'));
		expect(viewer).toContain(join(viewerDir, '284-note-drafts.test.ts'));
		expect(viewer).toHaveLength(12);
		expect(listed).toHaveLength(21);
		expect(prefixed('root').length + viewer.length).toBe(21);
	});
	test('the existing includes are kept', async () => {
		const { default: config } = await import('../../vitest.config');
		const projects = (config.test?.projects ?? []) as { test?: { name?: string; include?: string[]; exclude?: string[] } }[];
		const named = projects.filter((p) => p.test?.name === 'root');
		expect(named, 'one project named root').toHaveLength(1);
		expect(config.test?.include, 'no global include: it would collect the viewer files twice').toBeUndefined();
		expect(named[0]!.test?.include).toEqual(expect.arrayContaining(['tests/case-package/**/*.test.ts', 'src/lib/local-case/**/*.test.ts', 'src/lib/components/**/*.test.ts', 'tests/parity/**/*.test.ts']));
		expect(named[0]!.test?.exclude).toContain('tests/hosted-smoke/native-viewer/**');
	});
});
