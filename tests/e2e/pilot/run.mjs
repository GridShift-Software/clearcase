#!/usr/bin/env bun
// `bun run --bun test:e2e`: the ported browser and durability suites against the production build in ./build, each
// inside its own network namespace with only lo (tests/e2e/pilot/offline.sh), then the loopback bind check in the
// host namespace, then each M2 category's suite, tests/e2e/<category>/suite.mjs, where one exists (offline in its own
// namespace like the pilot suites, reported as its own step). It prints the categories it discovered, and a category
// with route files under src/routes/v/[vid]/<category>/ but no suite fails the run ("category <c> has views but no
// suite"); a category with neither is skipped. With E2E_ROOT set, categories, suites and implemented views are read
// from E2E_ROOT's tree. Every server runs under Bun via scripts/pilot/start.ts. Exit 0 only when every step passes;
// a missing tool (unshare, ip, Chromium) or a failed isolation proof fails the run.
// Suite summary contract: each category suite writes $CLEARCASE_E2E_OUT/<category>/summary.json as
// { "scenarios": [ { "id", "view", "pass" } ] }; its step fails when the file is missing or unreadable, the list is
// empty, an entry has pass other than true, or an implemented view of the category is in no scenario (suiteProblems).
// Fresh-build evidence (lib/fresh-build.ts): the build stamp must be HEAD's, made in <repo>/build, from and on a tree
// without modified or untracked (not ignored) files; otherwise exit 2 before any step, unless --allow-stale-build,
// which runs it with `evidence: false` in the summary and NOT EVIDENCE in the final status line.
// Results: $CLEARCASE_REPORT_DIR/e2e.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHROME, chromeAvailable } from './lib/cdp.mjs';
import { allowStale, evidenceRecord, evidenceSuffix, freshLine, freshness, readStamp, refusal } from './lib/fresh-build.ts';
import { implementedViews, registryOf } from './lib/implemented.mjs';
import { outDir } from './lib/record.mjs';
import { bunIdentity } from './lib/server.mjs';

const here = import.meta.dirname;
const root = join(here, '..', '..', '..');
/** The app tree under test: E2E_ROOT, else this checkout. */
const appRoot = resolve(process.env.E2E_ROOT ?? root);

/** The view categories whose owners may add tests/e2e/<category>/suite.mjs, in run order. */
export const CATEGORIES = ['evidence', 'analysis', 'quantum', 'registers', 'litigation', 'bundles', 'system'];
/** A suite run offline as the calling user, in its own network namespace with only lo. */
export const offlineStep = (suite) => ['unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(here, 'offline.sh'), process.execPath, suite]];
/** One offline step per category suite that exists under `e2eDir`. */
export const categorySteps = (e2eDir = join(appRoot, 'tests', 'e2e')) => CATEGORIES.filter((c) => existsSync(join(e2eDir, c, 'suite.mjs'))).map((c) => [`${c} suite (offline)`, offlineStep(join(e2eDir, c, 'suite.mjs')), c]);
const hasFiles = (d) => existsSync(d) && readdirSync(d, { withFileTypes: true }).some((e) => e.isFile() || (e.isDirectory() && hasFiles(join(d, e.name))));
/**
 * Which categories have a suite (tests/e2e/<c>/suite.mjs) and which have views (any file under
 * src/routes/v/[vid]/<c>/); `missing` lists the categories with views but no suite, each of which fails the run.
 */
export function discoverCategories({ e2eDir = join(appRoot, 'tests', 'e2e'), routesDir = join(appRoot, 'src', 'routes', 'v', '[vid]') } = {}) {
	const suites = CATEGORIES.filter((c) => existsSync(join(e2eDir, c, 'suite.mjs')));
	const views = CATEGORIES.filter((c) => hasFiles(join(routesDir, c)));
	return { suites, views, missing: views.filter((c) => !suites.includes(c)) };
}

/** Where a category suite writes what it ran. */
export const suiteSummaryFile = (out, category) => join(out, category, 'summary.json');

/**
 * The problems with a category suite's summary ({ scenarios: [{ id, view, pass }] }), given the ids of the category's
 * implemented views; an empty list when the suite proved what it ran.
 */
export function suiteProblems(out, category, implemented) {
	const file = suiteSummaryFile(out, category);
	const fix = `tests/e2e/${category}/suite.mjs must write ${file} as { "scenarios": [ { "id", "view", "pass" } ] }`;
	if (!existsSync(file)) return [`no suite summary: ${fix}`];
	let doc;
	try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return [`suite summary does not parse (${e.message}): ${fix}`]; }
	const sc = doc?.scenarios;
	if (!Array.isArray(sc) || sc.length === 0) return [`suite summary lists no scenarios: ${fix}, with one scenario or more`];
	const problems = [];
	const bad = sc.filter((x) => !x || typeof x.id !== 'string' || typeof x.view !== 'string' || typeof x.pass !== 'boolean');
	if (bad.length) problems.push(`${bad.length} scenario(s) lack a string id, a string view or a boolean pass: give every scenario all three`);
	const failed = sc.filter((x) => x?.pass !== true).map((x) => x?.id ?? '?');
	if (failed.length) problems.push(`scenario(s) not passed: ${failed.join(', ')}: fix them and rerun`);
	const seen = new Set(sc.map((x) => x?.view));
	const uncovered = [...implemented].filter((v) => !seen.has(v));
	if (uncovered.length) problems.push(`implemented view(s) in no scenario: ${uncovered.join(', ')}: add a scenario with "view" set to each`);
	return problems;
}

// Fail fast: each step runs at most 15 minutes (CLEARCASE_SUITE_TIMEOUT_MS; the browser suite takes about one, the
// durability suite about two) and is then stopped with SIGTERM, which fails it. A step that timed out, or a pilot step
// whose record says its run aborted (a dead browser, a scenario timeout: lib/lifecycle.mjs), makes the summary
// `evidence: false` with the reason.
/** A step's time limit in ms. */
export const STEP_TIMEOUT_MS = +(process.env.CLEARCASE_SUITE_TIMEOUT_MS ?? 15 * 60_000);
/** The record each pilot step writes in the output directory (lib/record.mjs), by step name. */
export const STEP_RECORDS = { 'browser suite (offline)': 'suite.json', 'durability suite (offline)': 'durability.json', 'loopback bind check (host namespace)': 'netcheck.json' };

/** Why a step proves nothing even if it passed: it timed out, or its record says the run aborted; else null. */
export function stepAbort(out, step) {
	if (step.timedOut) return `${step.name}: no result within ${STEP_TIMEOUT_MS / 1000} s (timeout); stopped`;
	if (!STEP_RECORDS[step.name]) return null;
	try {
		const a = JSON.parse(readFileSync(join(out, STEP_RECORDS[step.name]), 'utf8')).aborted;
		return a ? `${step.name}: run aborted in ${a.step}: ${a.cause}` : null;
	} catch { return null; }
}

if (import.meta.main) await main();

async function main() {
	const which = (c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
	// the build the suites use (they honour E2E_ROOT / E2E_BUILD_DIR the same way)
	const buildDir = resolve(process.env.E2E_BUILD_DIR ?? join(process.env.E2E_ROOT ?? root, 'build'));
	const pre = { unshare: which('unshare'), ip: which('ip'), chromium: chromeAvailable() ? CHROME : '', build: existsSync(join(buildDir, 'handler.js')) && existsSync(join(buildDir, 'clearcase-build.json')) };
	const missing = Object.entries(pre).filter(([, v]) => !v).map(([k]) => k);
	const dir = outDir();
	mkdirSync(dir, { recursive: true });
	const build = pre.build ? readStamp(buildDir) : null;
	const fresh = freshness(root, build, { buildDir, appRoot });
	const allowed = allowStale(process.argv.slice(2));
	console.log(`test:e2e: ${freshLine(fresh)}`);
	if (pre.build && !fresh.fresh && !allowed) {
		const msg = refusal('test:e2e', fresh);
		console.error(msg);
		writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ok: false, refused: msg, prerequisites: pre, bun: bunIdentity(), build, ...evidenceRecord(fresh, allowed), results: [] }, null, 1));
		process.exit(2);
	}
	const cats = discoverCategories();
	const reg = await registryOf(appRoot);
	const implemented = implementedViews(appRoot, reg.views);
	const implementedIn = (c) => reg.views.filter((v) => v.category === c && implemented.has(v.id)).map((v) => v.id);
	console.log(`test:e2e: categories with a suite: ${cats.suites.join(', ') || 'none'}; with views: ${cats.views.join(', ') || 'none'}`);
	for (const c of cats.missing) console.error(`test:e2e: category ${c} has views but no suite`);
	// remove the pilot steps' records first, so that only this run's can say it aborted (stepAbort)
	for (const f of Object.values(STEP_RECORDS)) rmSync(join(dir, f), { force: true });
	const offline = (file) => offlineStep(join(here, file));
	const steps = [
		['browser suite (offline)', offline('suite.mjs')],
		['durability suite (offline)', offline('durability.mjs')],
		['loopback bind check (host namespace)', [process.execPath, [join(here, 'netcheck.mjs')]]],
		...categorySteps(),
	];
	const results = [];
	if (missing.length) console.error(`test:e2e: missing prerequisites: ${missing.join(', ')} (build first with bun run --bun build)`);
	else for (const [name, [cmd, args], category] of steps) {
		const t0 = Date.now();
		console.log(`\n=== ${name}: ${cmd} ${args.join(' ')}`);
		if (category) rmSync(suiteSummaryFile(dir, category), { force: true });
		const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CLEARCASE_E2E_OUT: dir }, timeout: STEP_TIMEOUT_MS, killSignal: 'SIGTERM' });
		const res = { name, rc: r.status, ms: Date.now() - t0 };
		if (r.error?.code === 'ETIMEDOUT') {
			console.error(`test:e2e: ${name}: no result within ${STEP_TIMEOUT_MS / 1000} s; stopped`);
			Object.assign(res, { rc: 124, timedOut: true });
		}
		if (category) {
			const problems = suiteProblems(dir, category, implementedIn(category));
			for (const p of problems) console.error(`test:e2e: ${category} suite: ${p}`);
			if (problems.length) Object.assign(res, { rc: res.rc === 0 ? 1 : res.rc, summaryProblems: problems });
		}
		results.push(res);
	}
	const noSuite = cats.missing.map((c) => ({ name: `category ${c} has views but no suite`, rc: 1, ms: 0 }));
	const ok = missing.length === 0 && results.length === steps.length && results.every((r) => r.rc === 0) && noSuite.length === 0;
	const evidence = evidenceRecord(fresh, allowed, results.map((r) => stepAbort(dir, r)).filter(Boolean));
	writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ok, prerequisites: pre, missing, bun: bunIdentity(), build, ...evidence, categories: cats, results: [...results, ...noSuite] }, null, 1));
	console.log('\n' + [...results, ...noSuite].map((r) => `${r.rc === 0 ? 'PASS' : 'FAIL'} rc=${r.rc} ${(r.ms / 1000).toFixed(1)}s ${r.name}`).join('\n'));
	console.log(`test:e2e: ${ok ? 'PASS' : 'FAIL'}${evidenceSuffix(evidence)}`);
	process.exit(ok ? 0 : 1);
}
