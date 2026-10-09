// The e2e runner (run.mjs): category discovery (a category with views but no suite fails the run), the fresh-build
// refusal (exit 2 before any step) and its override (evidence: false in the summary). Synthetic trees and stamps in a
// temp folder; the runner never reaches a browser step here (the override run stops at a missing Chromium).
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
		const r = spawnSync(BUN, [join(HERE, 'run.mjs'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, E2E_BUILD_DIR: buildDir, CLEARCASE_E2E_OUT: out, CLEARCASE_CHROMIUM: join(root, 'no-chromium'), CLEARCASE_ALLOW_STALE_BUILD: '', ...env } });
		return { ...r, summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) };
	};
	test('a build of another revision is refused with exit 2 before any step', () => {
		const r = run(build('0000000000000000000000000000000000000000'));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/test:e2e: refusing a stale build \(the build is of 000000000000, not HEAD/);
		expect(r.summary).toMatchObject({ ok: false, evidence: false, results: [] });
	});
	test('--allow-stale-build (or CLEARCASE_ALLOW_STALE_BUILD=1) runs it, and the summary says evidence: false', () => {
		for (const [args, env] of [[['--allow-stale-build'], {}], [[], { CLEARCASE_ALLOW_STALE_BUILD: '1' }]] as const) {
			const r = run(build('0000000000000000000000000000000000000000', true), [...args], env);
			// past the refusal: it stops only at the missing Chromium (a prerequisite), never reaching a step
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/missing prerequisites: chromium/);
			expect(r.summary.evidence).toBe(false);
			expect(r.summary.freshBuild).toMatchObject({ fresh: false, allowStaleBuild: true, buildDirty: true });
			expect(r.summary.evidenceNote).toMatch(/^NOT release evidence \(--allow-stale-build\): the build is of 000000000000, not HEAD .*; the build was made from a tree with modified tracked files/);
		}
	});
});
