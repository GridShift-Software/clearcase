// The M2 base: the shared files parallel M2 owners would otherwise all edit discover each owner's own file instead.
// `bun run --bun measure --ticket CC-NN` runs scripts/measure/ccNN.mjs when it exists (CC-02 and CC-03 unchanged);
// `test:e2e` runs tests/e2e/<category>/suite.mjs offline after the pilot suites; the root vitest config includes the
// owners' test paths. Synthetic files in temp copies only: nothing here is written into the repository.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'm2-base-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const echo = (name: string) => `console.log(JSON.stringify({ runner: ${JSON.stringify(name)}, args: process.argv.slice(2) }));\nprocess.exit(${name === 'cc99' ? 7 : 0});\n`;

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
	const measure = (...args: string[]) => spawnSync(BUN, [join(copy, 'scripts', 'measure', 'index.ts'), ...args], { encoding: 'utf8', timeout: 30_000 });

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
		expect(src).toMatch(/results\.push\(\{ name, rc: r\.status, ms: Date\.now\(\) - t0 \}\)/);
	});
});

describe('vitest includes', () => {
	test("the owners' test paths are collected, other paths are not", () => {
		const tree = join(root, 'vitest');
		const files = ['tests/evidence/a/x.test.ts', 'tests/system/x.test.ts', 'tests/calculations/x.test.ts', 'src/lib/user-work/backup/x.test.ts', 'src/lib/views/registers/x.test.ts', 'src/lib/bundles/x.test.ts', 'tests/parity/x.test.ts', 'src/lib/other/x.test.ts', 'tests/e2e/evidence/x.test.ts', 'tests/acceptance/x.test.ts'];
		for (const f of files) put(join(tree, f), "import { test } from 'vitest';\ntest('synthetic', () => {});\n");
		const r = spawnSync(BUN, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly', '--root', tree, '--config', join(REPO, 'vitest.config.ts')], { encoding: 'utf8', timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout.trim().split('\n').sort()).toEqual(files.slice(0, 7).sort());
	});
	test('the existing includes are kept', async () => {
		const { default: config } = await import('../../vitest.config');
		expect(config.test?.include).toEqual(expect.arrayContaining(['tests/case-package/**/*.test.ts', 'src/lib/local-case/**/*.test.ts', 'src/lib/components/**/*.test.ts', 'tests/parity/**/*.test.ts']));
	});
});
