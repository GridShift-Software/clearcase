#!/usr/bin/env bun
// `bun run --bun test:e2e`: the ported browser and durability suites against the production build in ./build, each
// inside its own network namespace with only lo (tests/e2e/pilot/offline.sh), then the loopback bind check in the
// host namespace, then each M2 category's suite, tests/e2e/<category>/suite.mjs, where one exists (offline in its own
// namespace like the pilot suites, reported as its own step). It prints the categories it discovered, and a category
// with route files under src/routes/v/[vid]/<category>/ but no suite fails the run ("category <c> has views but no
// suite"); a category with neither is skipped. Every server runs under Bun via scripts/pilot/start.ts. Exit 0 only
// when every step passes; a missing tool (unshare, ip, Chromium) or a failed isolation proof fails the run.
// Fresh-build evidence (lib/fresh-build.ts): the build stamp must be HEAD's, from and on a tree without modified
// tracked files; otherwise exit 2 before any step, unless --allow-stale-build or CLEARCASE_ALLOW_STALE_BUILD=1, which
// runs it with `evidence: false` in the summary. Results: $CLEARCASE_REPORT_DIR/e2e.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHROME, chromeAvailable } from './lib/cdp.mjs';
import { allowStale, evidenceRecord, freshLine, freshness, refusal } from './lib/fresh-build.ts';
import { outDir } from './lib/record.mjs';
import { bunIdentity } from './lib/server.mjs';

const here = import.meta.dirname;
const root = join(here, '..', '..', '..');

/** The view categories whose owners may add tests/e2e/<category>/suite.mjs, in run order. */
export const CATEGORIES = ['evidence', 'analysis', 'quantum', 'registers', 'litigation', 'bundles', 'system'];
/** A suite run offline as the calling user, in its own network namespace with only lo. */
export const offlineStep = (suite) => ['unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(here, 'offline.sh'), process.execPath, suite]];
/** One offline step per category suite that exists under `e2eDir`. */
export const categorySteps = (e2eDir = join(here, '..')) => CATEGORIES.filter((c) => existsSync(join(e2eDir, c, 'suite.mjs'))).map((c) => [`${c} suite (offline)`, offlineStep(join(e2eDir, c, 'suite.mjs'))]);
const hasFiles = (d) => existsSync(d) && readdirSync(d, { withFileTypes: true }).some((e) => e.isFile() || (e.isDirectory() && hasFiles(join(d, e.name))));
/**
 * Which categories have a suite (tests/e2e/<c>/suite.mjs) and which have views (any file under
 * src/routes/v/[vid]/<c>/); `missing` lists the categories with views but no suite, each of which fails the run.
 */
export function discoverCategories({ e2eDir = join(here, '..'), routesDir = join(root, 'src', 'routes', 'v', '[vid]') } = {}) {
	const suites = CATEGORIES.filter((c) => existsSync(join(e2eDir, c, 'suite.mjs')));
	const views = CATEGORIES.filter((c) => hasFiles(join(routesDir, c)));
	return { suites, views, missing: views.filter((c) => !suites.includes(c)) };
}

if (import.meta.main) main();

function main() {
	const which = (c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
	// the build the suites use (they honour E2E_ROOT / E2E_BUILD_DIR the same way)
	const buildDir = resolve(process.env.E2E_BUILD_DIR ?? join(process.env.E2E_ROOT ?? root, 'build'));
	const pre = { unshare: which('unshare'), ip: which('ip'), chromium: chromeAvailable() ? CHROME : '', build: existsSync(join(buildDir, 'handler.js')) && existsSync(join(buildDir, 'clearcase-build.json')) };
	const missing = Object.entries(pre).filter(([, v]) => !v).map(([k]) => k);
	const dir = outDir();
	mkdirSync(dir, { recursive: true });
	const build = pre.build ? JSON.parse(readFileSync(join(buildDir, 'clearcase-build.json'), 'utf8')) : null;
	const fresh = freshness(root, build);
	const allowed = allowStale(process.argv.slice(2));
	console.log(`test:e2e: ${freshLine(fresh)}`);
	if (pre.build && !fresh.fresh && !allowed) {
		const msg = refusal('test:e2e', fresh);
		console.error(msg);
		writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ok: false, refused: msg, prerequisites: pre, bun: bunIdentity(), build, ...evidenceRecord(fresh, allowed), results: [] }, null, 1));
		process.exit(2);
	}
	const cats = discoverCategories();
	console.log(`test:e2e: categories with a suite: ${cats.suites.join(', ') || 'none'}; with views: ${cats.views.join(', ') || 'none'}`);
	for (const c of cats.missing) console.error(`test:e2e: category ${c} has views but no suite`);
	const offline = (file) => offlineStep(join(here, file));
	const steps = [
		['browser suite (offline)', offline('suite.mjs')],
		['durability suite (offline)', offline('durability.mjs')],
		['loopback bind check (host namespace)', [process.execPath, [join(here, 'netcheck.mjs')]]],
		...categorySteps(),
	];
	const results = [];
	if (missing.length) console.error(`test:e2e: missing prerequisites: ${missing.join(', ')} (build first with bun run --bun build)`);
	else for (const [name, [cmd, args]] of steps) {
		const t0 = Date.now();
		console.log(`\n=== ${name}: ${cmd} ${args.join(' ')}`);
		const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CLEARCASE_E2E_OUT: dir } });
		results.push({ name, rc: r.status, ms: Date.now() - t0 });
	}
	const noSuite = cats.missing.map((c) => ({ name: `category ${c} has views but no suite`, rc: 1, ms: 0 }));
	const ok = missing.length === 0 && results.length === steps.length && results.every((r) => r.rc === 0) && noSuite.length === 0;
	const evidence = evidenceRecord(fresh, allowed);
	writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ok, prerequisites: pre, missing, bun: bunIdentity(), build, ...evidence, categories: cats, results: [...results, ...noSuite] }, null, 1));
	console.log('\n' + [...results, ...noSuite].map((r) => `${r.rc === 0 ? 'PASS' : 'FAIL'} rc=${r.rc} ${(r.ms / 1000).toFixed(1)}s ${r.name}`).join('\n'));
	if (!evidence.evidence) console.log(`test:e2e: evidence: false (${evidence.evidenceNote})`);
	process.exit(ok ? 0 : 1);
}
