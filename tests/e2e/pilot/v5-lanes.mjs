#!/usr/bin/env bun
// `bun run --bun verify:pilot:v5`: the ten GRS-12 (CC-03) scenarios on the REAL v5 sample, offline, against the
// production build under Bun, plus the registry, date, source-route, page, contract and isolation checks. Writes
// lane-NN.txt and lane-NN.png (NN = 01..10), check-<name>.txt, criteria.md, criteria.json and lanes-v5.json into
// $CLEARCASE_REPORT_DIR (default .local/v5-report). Exit 0 only if every lane and check passes; 2 on a
// configuration or prerequisite error.
//
//   bun tests/e2e/pilot/v5-lanes.mjs [--isolated[=REV]] [--config FILE]
//
// Build under test: E2E_ROOT / E2E_BUILD_DIR when set, else the worktree's ./build (so running it after
// `bun run --bun build` tests the current build); --isolated builds REV (default HEAD) in a disposable copy with
// tests/e2e/pilot/lib/isolated-build.mjs. The build stamp is recorded either way.
//
// Isolation: outside the namespace the runner re-execs itself as
//   unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh bun <self> <args>
// and proves inside that only lo exists and nothing leaves the machine; any missing tool (unshare, ip, Chromium)
// or isolation failure fails the run, with no online fallback. Ports: servers 43700-43898, canary 43899.
//
// Case material: the locator (.local/v5-verification.json: caseFolder, caseId, mainHtml, references.inventory,
// expectedExamples {path, sha256 = the profile pin}, accepted {resultsVersion, diagnosticsSha256}, optional
// pilot {workDir, packageDir}) and everything derived from it stay in .local/ and the report directory. This file
// holds no case values. The canonical fixture is read only; negative controls use disposable copies in workDir.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildFromEnv, bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, sha256Bytes, treeStamp } from './v5/env.mjs';

ensureOffline(import.meta.filename);

const { proveOffline } = await import('./lib/netproof.mjs');
const { startCanary } = await import('./lib/canary.mjs');
const { launch } = await import('./lib/cdp.mjs');
const { client } = await import('./lib/client.mjs');
const { startServer } = await import('./lib/server.mjs');
const { isolatedBuild } = await import('./lib/isolated-build.mjs');
const { ConfigError, fixtureLine, loadConfig, readPackage, v5Package } = await import('./v5/fixture.mjs');
const { openPage } = await import('./v5/browser.mjs');
const { Lane, runLane, writeLane } = await import('./v5/record.mjs');
const L = await import('./v5/lanes.mjs');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (i < 0) return undefined; const a = argv[i]; return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const out = resolve(process.env.CLEARCASE_REPORT_DIR ?? join(REPO, '.local', 'v5-report'));
mkdirSync(out, { recursive: true });
const die = (code, msg) => { console.error(`verify:pilot:v5: ${msg}`); writeFileSync(join(out, 'lanes-v5.json'), JSON.stringify({ ok: false, error: msg }, null, 1)); process.exit(code); };

const proof = await proveOffline();
if (!proof.pass) die(1, `offline proof failed: ${JSON.stringify(proof)}`);
let fx;
try { fx = await loadConfig(arg('config') ? resolve(String(arg('config'))) : undefined); } catch (e) { die(e instanceof ConfigError ? 2 : 1, e.message); }
const work = fx.workDir;
const localDir = join(REPO, '.local') + '/';
if (!(work + '/').startsWith(localDir) || work.startsWith(fx.caseFolder + '/') || fx.caseFolder.startsWith(work + '/')) die(2, `pilot.workDir ${work} must lie inside ${localDir} and must not overlap the case folder`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const git = gitIdentity();
const bun = bunIdentity();
const chromium = chromiumIdentity();
const host = hostIdentity();
const treeBefore = treeStamp(fx.caseFolder);
const runnerFiles = ['tests/e2e/pilot/v5-lanes.mjs', 'tests/e2e/pilot/v5/env.mjs', 'tests/e2e/pilot/v5/fixture.mjs', 'tests/e2e/pilot/v5/browser.mjs', 'tests/e2e/pilot/v5/record.mjs', 'tests/e2e/pilot/v5/lanes.mjs'];
const runner = Object.fromEntries(runnerFiles.map((f) => [f, sha256Bytes(readFileSync(join(REPO, f))).slice(0, 16)]));

let build;
const iso = arg('isolated');
if (iso) {
	const rev = iso === true ? 'HEAD' : String(iso);
	console.log(`isolated build of ${rev} ...`);
	try { const r = isolatedBuild({ repo: REPO, rev, dir: join(work, 'iso'), log: (m) => console.log(m) }); build = { root: r.src, buildDir: r.buildDir, stamp: r.stamp, mode: `isolated copy of ${r.revision} (git archive + reflinked node_modules, bun run --bun build, ${Math.round(r.buildMs)} ms)`, revision: r.revision }; }
	catch (e) { die(1, `isolated build failed: ${e.message}`); }
} else {
	const b = buildFromEnv();
	if (b.problem) die(2, b.problem);
	build = { ...b, mode: process.env.E2E_BUILD_DIR || process.env.E2E_ROOT ? 'E2E_ROOT/E2E_BUILD_DIR' : 'worktree ./build', revision: b.stamp.revision };
}
const buildMatchesHead = build.stamp?.revision === git.head && !build.stamp?.dirty;
// When the stamp names another commit, list what differs between it and HEAD (an app-equivalence note, not a pass).
const buildDelta = (() => {
	if (!build.stamp?.revision || build.stamp.revision === git.head) return null;
	const r = spawnSync('git', ['-C', REPO, 'diff', '--name-only', build.stamp.revision, git.head], { encoding: 'utf8' });
	if (r.status !== 0) return { error: (r.stderr || 'git diff failed').trim() };
	const paths = r.stdout.split('\n').filter(Boolean);
	const app = paths.filter((f) => /^(src|static|scripts\/pilot)\/|^(svelte\.config\.js|vite\.config\.ts|tsconfig\.json|bun\.lock)$/.test(f));
	let pkgScriptsOnly = null;
	if (paths.includes('package.json')) {
		const show = (rev) => { const x = JSON.parse(spawnSync('git', ['-C', REPO, 'show', `${rev}:package.json`], { encoding: 'utf8' }).stdout); delete x.scripts; return JSON.stringify(x); };
		pkgScriptsOnly = show(build.stamp.revision) === show(git.head);
	}
	return { paths, appPaths: app, packageJsonScriptsOnly: pkgScriptsOnly, appEquivalent: app.length === 0 && pkgScriptsOnly !== false };
})();

console.log(`converting the v5 main HTML with GRS-10's converter ...`);
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
const pkgDir = pkgRun.dir;
const pkg = pkgRun.exit === 0 || existsSync(join(pkgDir, 'manifest.json')) ? readPackage(pkgDir) : null;
const caseName = pkg ? (pkg.manifest.case?.label || pkg.manifest.case?.id) : fx.caseId;

const port = PORTS.first, origPort = PORTS.first + 1;
const dataDir = join(work, 'data');
const logFile = join(work, 'server.log');
const serverCommand = `PORT=${port} ORIGINALS_PORT=${origPort} CLEARCASE_DATA_DIR=${dataDir} BUILD_DIR=${build.buildDir} ${process.execPath} ${join(build.root, 'scripts', 'pilot', 'start.ts')}`;
const canary = await startCanary();
const C = {
	fx, pkg, pkgDir, pkgRun, caseName, out, work, port, origPort, dataDir, build, bun, proof, canary, treeBefore, serverCommand,
	origin: `http://127.0.0.1:${port}`, c: client(port), S: {}, lanes: new Map(), cleanup: [],
};
const start = async () => { C.srv = await startServer({ root: build.root, port, origPort, dataDir, buildDir: build.buildDir, logFile }); C.orig = C.srv.health.instance.originalsOrigin; return C.srv; };
C.restart = start;

const header = () => [
	`revision: ${git.head} on ${git.branch}${git.dirty ? ` (worktree dirty: ${git.dirtyPaths.slice(0, 12).join(', ')}${git.dirtyPaths.length > 12 ? ', …' : ''})` : ' (clean)'}`,
	`runner: ${Object.entries(runner).map(([f, h]) => `${f} sha256 ${h}…`).join('; ')}`,
	`build under test: ${build.mode}; root ${build.root}; build dir ${build.buildDir}`,
	`build stamp: ${JSON.stringify(build.stamp)}; stamp revision equals HEAD and clean: ${buildMatchesHead ? 'yes' : 'NO (evidence is for the stamped build, not for HEAD)'}${buildDelta ? `; stamp..HEAD changed ${JSON.stringify(buildDelta.paths ?? buildDelta.error)}, app sources changed: ${JSON.stringify(buildDelta.appPaths ?? null)}, package.json scripts-only: ${buildDelta.packageJsonScriptsOnly}, app-equivalent: ${buildDelta.appEquivalent ? 'yes' : 'NO'}` : ''}${build.stamp?.dirty ? '; stamp dirty = tracked files modified at build time (copy-pdfjs.ts uses git status --untracked-files=no)' : ''}`,
	`bun: ${bun.version} (${bun.revision}) at ${bun.path}; server started as: ${serverCommand}`,
	`chromium: ${chromium.version} at ${chromium.path}`,
	`host: ${host.hostname}, ${host.cpu} x${host.logicalCpus}, ${host.memoryGiB} GiB, ${host.kernel}`,
	fixtureLine(fx),
	`package: ${pkgRun.reused ? `reused ${pkgDir}` : `converted into ${relative(REPO, pkgDir)}`} (${Math.round(pkgRun.ms)} ms); resultsVersion ${pkg?.manifest.resultsVersion ?? 'none'}`,
	`offline: network namespace ${proof.netns}, links ${JSON.stringify(proof.links)}, outbound ${JSON.stringify(proof.outbound)}, dns ${proof.dns}, loopback ${proof.loopback}; canary 127.0.0.1:${PORTS.canary}`,
	`command: bun tests/e2e/pilot/v5-lanes.mjs ${argv.join(' ')} (CLEARCASE_REPORT_DIR=${out})`,
];

const TITLES = {
	1: 'Compare the complete import-to-document workflow with the reference',
	2: 'Import and preview v5 without activation',
	3: 'Activate and see exactly 1,689 base records',
	4: 'Sort and filter chronology with fixed expected rows',
	5: 'Open a cited PDF',
	6: 'Open or download a non-PDF original',
	7: 'Show a missing-original state',
	8: 'Reject a broken candidate while the active version remains usable',
	9: 'Use keyboard navigation and browser Back',
	10: 'Restart with networking disabled and recover the active case',
};
const EXTRA = {
	stack: 'Stack and toolchain identity: Bun, pins, storage pragmas, GRS-10 scripts preserved',
	registry: 'All 42 registry entries and their destinations against docs/plan/view-coverage.json (BA-18)',
	dates: 'Date provenance on dated and undated rows (BA-04)',
	routes: 'The three source routes: direct, through the parent e-mail, unavailable (BA-09)',
	pages: 'Page provenance: [[REF#pN]] search and the ?page=N route',
	contracts: 'Shared contracts: citation route, original-open states, titles, narrative allowlist',
	isolation: 'Offline isolation, loopback binding, canary, originals outside Git, fixture unchanged',
	slots: 'Overview widget slots: declared slots unfilled and naming their owner (GRS-17, GRS-20)',
};
async function checkStack(C, Ln) {
	const pj = JSON.parse(readFileSync(join(build.root, 'package.json'), 'utf8'));
	const h = await C.c.health();
	Ln.check('packageManager pinned to bun@1.4.2 and the server runs that Bun', { pin: 'bun@1.4.2', server: '1.4.2', stamp: '1.4.2' }, { pin: pj.packageManager, server: h.instance.bun, stamp: build.stamp?.bun ?? null });
	const ranges = Object.entries({ ...pj.dependencies, ...pj.devDependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
	Ln.check('every dependency is an exact pin (no ranges or tags)', [], ranges);
	Ln.check('SvelteKit app with the pinned framework versions', { kit: '2.70.3', svelte: '5.57.2', vite: '8.3.4', adapter: '5.5.7', pdfjs: '6.4.299' }, { kit: pj.devDependencies['@sveltejs/kit'], svelte: pj.devDependencies.svelte, vite: pj.devDependencies.vite, adapter: pj.devDependencies['@sveltejs/adapter-node'], pdfjs: pj.devDependencies['pdfjs-dist'] });
	Ln.check('SQLite under Bun: results WAL, work DELETE, synchronous FULL (health pragmas)', { main: { journal_mode: 'wal', synchronous: 2 }, work: { journal_mode: 'delete', synchronous: 2 } }, { main: h.pragmas?.main, work: h.pragmas?.work });
	Ln.check('GRS-10 scripts preserved (convert, validate, verify:package)', [true, true, true], ['convert', 'validate', 'verify:package'].map((s) => typeof pj.scripts?.[s] === 'string'));
	Ln.note('the stack comparison itself is documentary (spike judge evidence, docs/development.md); GRS-10\'s own suites are not re-run here');
}

const order = [2, 3, 1, 4, 5, 6, 'stack', 'registry', 'slots', 'dates', 9, 7, 'routes', 'pages', 8, 10, 'contracts', 'isolation'];
const bodies = { 1: L.lane1, 2: L.lane2, 3: L.lane3, 4: L.lane4, 5: L.lane5, 6: L.lane6, 7: L.lane7, 8: L.lane8, 9: L.lane9, 10: L.lane10, stack: checkStack, registry: L.checkRegistry, dates: L.checkDates, routes: L.checkRoutes, pages: L.checkPages, contracts: L.checkContracts, slots: L.checkSlots, isolation: L.checkIsolation };
let b;
try {
	if (!pkg) throw new Error(`no v5 package: ${pkgRun.stderr}`);
	await start();
	b = await launch({ profileRoot: join(work, 'profiles') });
	C.b = b;
	C.P = await openPage(b);
	let aborted = null;
	for (const id of order) {
		const lane = new Lane(id, TITLES[id] ?? EXTRA[id], { negativeControl: id === 7 || id === 8 });
		C.lanes.set(id, lane);
		if (aborted) { lane.status = 'FAIL'; lane.note(`not run: ${aborted}`); continue; }
		await runLane(lane, (x) => bodies[id](C, x));
		if (C.srv?.exited) aborted = `the server exited (${JSON.stringify(C.srv.exited)}); see ${logFile}`;
	}
} catch (e) {
	console.error(`run aborted: ${e?.stack ?? e}`);
	for (const id of order) if (!C.lanes.has(id)) { const lane = new Lane(id, TITLES[id] ?? EXTRA[id]); lane.status = 'FAIL'; lane.note(`not run: ${String(e).slice(0, 500)}`); C.lanes.set(id, lane); }
} finally {
	await b?.close().catch(() => {});
	await C.srv?.stop().catch(() => {});
	await canary.close().catch(() => {});
}

// ---- outputs --------------------------------------------------------------------------------------------------------
const hdr = header();
const files = {};
for (const lane of C.lanes.values()) files[lane.id] = writeLane(out, lane, hdr);
try { writeFileSync(join(out, 'server.log'), readFileSync(logFile)); } catch { /* no server ran */ }
const st = (id) => C.lanes.get(id)?.status ?? 'FAIL';
const ev = (ids) => ids.map((id) => `${typeof id === 'number' ? `lane-${String(id).padStart(2, '0')}` : `check-${id}`} ${st(id)}`);
const CRITERIA = [
	['GRS-12 #1', 'Choose and pin the local stack (SvelteKit + TypeScript, Bun 1.4.2, SQLite)', ['stack']],
	['GRS-12 #2', 'Case-folder selection, validation report, candidate preview, activation, overview, chronology, document detail; open/download with unsupported and missing states', [2, 3, 1, 4, 5, 6, 7]],
	['GRS-12 #3', 'Active version unchanged on failed import; originals outside Git; loopback only; works offline', [8, 10, 'isolation']],
	['GRS-12 #4', 'History-aware navigation, accessible focus, case-aware titles, citation links, reproducible boot/verification command', [9, 5, 'pages', 'contracts']],
	['GRS-12 #5', 'Navigation entries and route extension points for all 42 views; unimplemented entries explicitly unavailable (incl. the overview widget slots)', ['registry', 'slots']],
	['GRS-12 #6', 'Ownership transfer after CC-02: package.json/bun.lock/tsconfig/vitest extended, accepted behaviour preserved (scripts and pins only; GRS-10 suites not re-run here)', ['stack']],
	['GRS-12 #7', 'Safe rendering and link policy; original content never runs with app privileges (real data: isolated viewer, sandboxed text, download only; hostile inputs are covered by test:e2e, not here)', [5, 6, 'contracts']],
	['GRS-12 #8', 'Chronology dates keep the source value and expose type/provenance or say basis unknown (BA-04)', ['dates']],
	['GRS-12 #9', 'Navigation names match their destinations and use task names (BA-18)', ['registry']],
	['BA-09', 'Direct original, parent-e-mail route and unavailable source distinguished', ['routes', 1, 7]],
	['BA-14', 'Navigation semantics match keyboard behaviour; focus and Back work', [9]],
	['BA-16', 'Case-, section- and document-aware titles and history entries', [9, 2, 'registry']],
];
const matrix = CRITERIA.map(([id, text, ids]) => ({ criterion: id, text, evidence: ev(ids), files: ids.map((x) => files[x]).filter(Boolean), status: ids.every((x) => st(x) === 'PASS') ? 'PASS' : 'FAIL' }));
const ok = [...C.lanes.values()].every((l) => l.status === 'PASS') && C.lanes.size === order.length;
const meta = { ok, revision: git, build: { mode: build.mode, root: build.root, buildDir: build.buildDir, stamp: build.stamp, matchesHead: buildMatchesHead, deltaToHead: buildDelta }, bun, chromium, host, fixture: fx.sha256, offline: proof, canaryHits: canary.hits.length, command: `bun tests/e2e/pilot/v5-lanes.mjs ${argv.join(' ')}`, reportDir: out };
writeFileSync(join(out, 'criteria.json'), JSON.stringify({ ...meta, matrix }, null, 1));
writeFileSync(join(out, 'criteria.md'), [
	'# GRS-12 (CC-03) real-v5 criteria matrix', '',
	`Result: **${ok ? 'PASS' : 'FAIL'}** at ${git.head}${git.dirty ? ' (worktree dirty)' : ''}; build ${build.stamp?.buildId} from ${build.stamp?.revision}${build.stamp?.dirty ? ' (dirty)' : ''} (${build.mode}; matches HEAD: ${buildMatchesHead ? 'yes' : `no${buildDelta ? `, app-equivalent to HEAD: ${buildDelta.appEquivalent ? 'yes' : 'NO'} (changed: ${(buildDelta.paths ?? []).join(', ')})` : ''}`}); Bun ${bun.version}; ${chromium.version}; offline namespace ${proof.netns}.`, '',
	`Command: \`bun tests/e2e/pilot/v5-lanes.mjs ${argv.join(' ')}\` (exit ${ok ? 0 : 1}). Lanes 07 and 08 are negative controls on disposable copies.`, '',
	'| Criterion | Requirement | Evidence (command results) | Files | Status |', '| --- | --- | --- | --- | --- |',
	...matrix.map((m) => `| ${m.criterion} | ${m.text} | ${m.evidence.join('; ')} | ${m.files.join(', ')} | ${m.status} |`), '',
	'## Lanes and checks', '',
	'| Id | Title | Assertions | Status |', '| --- | --- | --- | --- |',
	...[...C.lanes.values()].sort((a, b) => (typeof a.id === 'number' ? a.id : 100) - (typeof b.id === 'number' ? b.id : 100)).map((l) => `| ${typeof l.id === 'number' ? `lane-${String(l.id).padStart(2, '0')}` : `check-${l.id}`} | ${l.title}${l.negativeControl ? ' (negative control)' : ''} | ${l.checks.filter((c) => c.pass).length}/${l.checks.length} | ${l.status} |`), '',
].join('\n'));
writeFileSync(join(out, 'lanes-v5.json'), JSON.stringify({ ...meta, lanes: [...C.lanes.values()].map((l) => ({ id: l.id, title: l.title, negativeControl: l.negativeControl, status: l.status, ms: l.ms, commands: l.commands, checks: l.checks, files: l.files, error: l.error })) }, null, 1));
for (const d of C.cleanup) rmSync(d, { recursive: true, force: true });
if (!process.env.CLEARCASE_KEEP_WORK) rmSync(work, { recursive: true, force: true });
console.log(`\nverify:pilot:v5: ${ok ? 'PASS' : 'FAIL'} (${[...C.lanes.values()].filter((l) => l.status === 'PASS').length}/${C.lanes.size} lanes and checks) -> ${out}`);
process.exit(ok ? 0 : 1);
