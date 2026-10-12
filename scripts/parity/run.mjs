#!/usr/bin/env bun
// Parity harness: v5 versus the app, view by view, offline (CC-29 / GRS-37).
//
//   bun run --bun parity -- [--view ID[,ID...] | --all] --fixture-config .local/v5-verification.json --out DIR
//       [--clock ISO] [--timezone TZ] [--approved-only] [--no-sweeps] [--no-exports] [--app-root DIR]
//       [--register FILE] [--strict-register] [--keep-work] [--keep-snapshots] [--app-v5-html FILE] [--allow-stale-build]
//
// For each view it extracts what v5 shows (the main HTML opened read-only from the fixture tree as a file: URL, Date
// frozen at the clock, timezone fixed, every non-file request counted and fatal) and what the app shows (the
// production build under Bun with CLEARCASE_FIXED_NOW at the same clock, the converted v5 package imported and
// activated), normalizes both into one snapshot shape and compares them value by value. Each difference is either
// covered by the intentional-differences register (docs/reference/parity/intentional-differences.json, then the owners'
// fragments in its register/ folder; --register FILE reads FILE and FILE's register/ folder) or unregistered. Writes DIR/views/<view>.json (paths and values: case-bearing, local only) and DIR/scorecard.json
// plus DIR/scorecard.md (counts only).
//
// Exit 0: no unregistered difference. 1: an unregistered difference, a view that did not extract on either side (never
// covered by the register), or an isolation breach (a v5 or app network request, a canary hit, a changed fixture
// tree). 2: setup error (arguments, fixture locator, register, including a whole-view owner that is not the view
// registry's, an --out overlapping a fixture input or holding a symlink where it writes, build, offline proof, and a
// stale build: one whose stamp is not HEAD's, not made in this repository's own build/ (an --app-root build is never
// evidence), or made from or run on a tree with modified or untracked (not ignored) files, unless --allow-stale-build,
// which runs it with `evidence: false` in the scorecard and NOT EVIDENCE in the final status line;
// tests/e2e/pilot/lib/fresh-build.ts). A run also records `evidence: false`, whatever its exit code, when a file it
// read by name is not a committed review input (tracked, unmodified and not hidden from git as given and resolved,
// inside its folder, and the bytes it read are HEAD's blob): a register file (the main file, --register FILE and every
// fragment it read), or an adapter, v5 spec or slot plug-in found by listing its folder (lib/modules.mjs); with
// --register FILE outside docs/reference/parity/; and when it compares less than the gate:
// --no-sweeps, --no-exports, PARITY_MAX_COMBOS, or --app-v5-html (lib/register.mjs runNonEvidence). The scorecard
// records the fixture identity it ran against: the accepted resultsVersion (GRS-38's view-content identity when the
// converter emits view-content), the package's own resultsVersion and the pinned input hashes.
//
// Isolation: outside the network namespace the runner re-execs itself through tests/e2e/pilot/offline.sh under
// `unshare -rn` (tests/e2e/pilot/v5/env.mjs ensureOffline); inside, it proves that only loopback exists before it
// starts anything. One browser runs at a time. --app-root points at another checkout's build (the mutation proof).
// --app-v5-html replaces the app side with the v5 adapter on another copy of the v5 HTML (self-parity: the control and
// the register-edit mutation, where the pilot has no register yet). Register entries that covered nothing in the run
// are reported as unused; --strict-register fails on them (an improvement that reverted to v5 behaviour matches v5,
// so only its unused entry shows it).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { ensureOffline, gitIdentity, PORTS, REPO, treeStamp } from '../../tests/e2e/pilot/v5/env.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return undefined; return argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]; };
const setup = (msg) => { console.error(`parity: setup error: ${msg}`); process.exit(2); };
if (flag('help')) { const lines = readFileSync(import.meta.filename, 'utf8').split('\n').slice(1); console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
if (!opt('fixture-config')) setup('--fixture-config FILE is required');
if (!opt('out')) setup('--out DIR is required');
if (!flag('all') && !opt('view')) setup('pass --all or --view ID');
const { loadRegister, registryKeys, registryOwners, runNonEvidence, unusedEntries, viewIds } = await import('./lib/register.mjs');
const reg = loadRegister(opt('register') ? resolve(opt('register')) : undefined, { owners: await registryOwners(), keys: await registryKeys() });
if (reg.problems.length) setup(`register invalid:\n  ${reg.problems.join('\n  ')}`);
const { checkOutput, fixtureInputs, locatorInputs, prepareOutput, removeOnExit } = await import('./lib/outdir.mjs');
const out = resolve(opt('out'));
const ALL = viewIds();
const views = flag('all') ? ALL : String(opt('view')).split(',');
const appV5Html = opt('app-v5-html') && resolve(opt('app-v5-html'));
// every path the runner writes below --out; each must resolve to itself (no symlink planted in the output)
const CHILDREN = ['views', 'scorecard.json', 'scorecard.md', 'register-usage.json', 'canary-hits.json', 'v5-requests.json', ...views.flatMap((v) => [`views/${v}.json`, `views/${v}.snapshots.json`])];
// path-only check against the raw locator, before loadConfig reads or hashes anything (it runs again on the loaded one)
const rawLocator = (() => { try { return JSON.parse(readFileSync(resolve(opt('fixture-config')), 'utf8')); } catch { return null; } })();
if (rawLocator) try { checkOutput(out, locatorInputs(rawLocator, { appV5Html }), CHILDREN); } catch (e) { setup(e.message); }
// fresh-build evidence, before anything starts: the build must be HEAD's, from and on a tree without modified tracked
// files (exit 2 otherwise, unless --allow-stale-build); a missing build is the setup error further down
const appRoot = resolve(opt('app-root') ?? REPO);
const buildDir = join(appRoot, 'build');
const { allowStale, evidenceRecord, evidenceSuffix, freshLine, freshness, readStamp, refusal } = await import('../../tests/e2e/pilot/lib/fresh-build.ts');
const stampFile = join(buildDir, 'clearcase-build.json');
const fresh = freshness(REPO, readStamp(buildDir), { buildDir, appRoot });
const allowedStale = allowStale(argv);
if (existsSync(stampFile) && !fresh.fresh && !allowedStale) setup(refusal('parity', fresh).replace(/^parity: /, ''));

ensureOffline(import.meta.filename);

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { startCanary } = await import('../../tests/e2e/pilot/lib/canary.mjs');
const { launch, DISABLED_FEATURES } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { abortOf, abortReason, deadline, exitWithin, guard } = await import('../../tests/e2e/pilot/lib/lifecycle.mjs');
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { ConfigError, loadConfig, PROFILE, v5Package, readPackage } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
const { v5Page, appPage, BROWSER_INTERNAL } = await import('./lib/browser.mjs');
const { classify, diff, runFailures, scorecard, TYPES } = await import('./lib/compare.mjs');
const { chronologyDims } = await import('./lib/sweeps.mjs');
const { extractV5View, v5Nav } = await import('./adapters/v5/index.mjs');
const { SPEC_DIR } = await import('./adapters/v5/specs.mjs');
const { SLOTS_DIR } = await import('./adapters/app/_shell.mjs');
const { IMPORTED, checkedModules, importModule, moduleFiles } = await import('./lib/modules.mjs');
const { appFromAdapter, appWithoutAdapter, emptySnapshot } = await import('./lib/snapshot.mjs');

const t0 = performance.now();
const clock = opt('clock') ?? '2026-10-08T09:00:00Z';
const timezone = opt('timezone') ?? 'UTC';
if ((out + '/').startsWith(REPO + '/') && !(out + '/').startsWith(join(REPO, '.local') + '/')) setup(`--out ${out} lies in the repository outside .local/: per-view diffs carry case values and must stay out of Git`);
for (const v of views) if (!ALL.includes(v)) setup(`unknown view ${v} (one of the 42 v5 navigation ids)`);

const proof = await proveOffline();
if (!proof.pass) setup(`offline proof failed: ${JSON.stringify(proof)}`);
let fx;
try { fx = await loadConfig(resolve(opt('fixture-config'))); } catch (e) { setup(e instanceof ConfigError ? e.message : String(e)); }
if (!existsSync(join(buildDir, 'handler.js')) || !existsSync(join(buildDir, 'clearcase-build.json'))) setup(`no production build at ${buildDir} (run bun run --bun build there)`);
const stamp = readStamp(buildDir);
const { VIEWS } = await import(join(appRoot, 'src', 'lib', 'components', 'view-registry.ts'));
const registry = Object.fromEntries(VIEWS.map((v) => [v.id, v]));
// a view whose owner route exists in the app tree is implemented, whatever the registry status says (it flips only
// after the owner's gate): it must have an adapter that extracts it
const { implementedViews } = await import('../../tests/e2e/pilot/lib/implemented.mjs');
const implemented = implementedViews(appRoot, VIEWS);
const adapters = {};
const APP_ADAPTERS = join(import.meta.dirname, 'adapters', 'app');
for (const file of moduleFiles(APP_ADAPTERS)) {
	const f = basename(file);
	const a = (await importModule(file)).default;
	if (!a?.view || typeof a.extract !== 'function') setup(`app adapter ${f} must export default { view, extract }`);
	adapters[a.view] = a;
}

// nothing is written before this: an output overlapping the fixture or holding a symlinked child is refused, working
// directories of killed runs are swept, and this run's is fresh
let at, work;
try { ({ at, work } = prepareOutput(out, fixtureInputs(fx, { appV5Html }), CHILDREN, { keep: flag('keep-work') })); } catch (e) { setup(e.message); }
// removed on every exit, a later setup error and SIGINT/SIGTERM/SIGHUP included, so failed runs do not pile up
// case-bearing working directories
if (!flag('keep-work')) removeOnExit(work);
const treeBefore = treeStamp(fx.caseFolder);
const git = gitIdentity();

console.log(`parity: ${views.length} view(s); clock ${clock} ${timezone}; app ${relative(REPO, appRoot) || '.'} build ${stamp.buildId} from ${stamp.revision?.slice(0, 12)}${stamp.dirty ? ' (dirty)' : ''}; HEAD ${git.head.slice(0, 12)}; ${freshLine(fresh)}`);
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0 && !existsSync(join(pkgRun.dir, 'manifest.json'))) setup(`v5 conversion failed: ${pkgRun.stderr}`);
const pkg = readPackage(pkgRun.dir);
if (pkg.manifest.resultsVersion !== fx.accepted.resultsVersion) setup(`converted resultsVersion ${pkg.manifest.resultsVersion} is not the accepted ${fx.accepted.resultsVersion}`);
const dims = chronologyDims(pkg.chronology);

const canary = await startCanary();
let srv, b, exitCode = 0, aborted = null;
const perView = {}, details = {};
// Fail fast (tests/e2e/pilot/lib/lifecycle.mjs): the browser setup and each view run under a deadline (setup 3 min,
// a view 5 min; the slowest view, chronology, takes about 80 s) and end at once when Chromium exits or a page crashes.
// The run then stops with exit 2, names the view and the cause, and its scorecard records `evidence: false` and
// `aborted`, as for any aborted run; a launch that failed once and then worked is recorded in `browser`.
const SETUP_MS = deadline(3 * 60_000), VIEW_MS = deadline(5 * 60_000);
try {
	const port = PORTS.first + 40, origPort = port + 1;
	srv = await startServer({ root: appRoot, port, origPort, dataDir: join(work, 'data'), buildDir, logFile: join(work, 'server.log'), env: { CLEARCASE_FIXED_NOW: clock, TZ: timezone } });
	const c = client(port);
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!imp.importId) throw Object.assign(new Error(`import failed: ${imp.status} ${imp.text?.slice(0, 300)}`), { setup: true });
	const act = await c.activate(imp.importId, { ack: true });
	const vid = await c.activeVersion();
	if (vid !== fx.accepted.resultsVersion) throw Object.assign(new Error(`activation failed: ${JSON.stringify(act)}`), { setup: true });
	// the browser's own services (network time, push messaging, phishing lists) are background traffic, not the
	// page's: switch them off (the last --disable-features wins, so it repeats the shared list)
	const { v5, app, selfV5, ctx } = await guard('setup (browser and pages)', SETUP_MS, async () => {
		b = await launch({ profileRoot: join(work, 'profiles'), extra: [`--disable-features=${DISABLED_FEATURES},NetworkTimeServiceQuerying,PushMessaging,BackgroundFetch`, '--disable-notifications', '--disable-default-apps', '--disable-client-side-phishing-detection', '--disable-component-extensions-with-background-pages'] });
		const v5 = await v5Page(b, { html: fx.cfg.mainHtml.path, clock, timezone });
		const app = await appPage(b, { origin: c.origin, timezone });
		const selfV5 = opt('app-v5-html') ? await v5Page(b, { html: resolve(opt('app-v5-html')), clock, timezone }) : null;
		const ctx = { clock, timezone, dims, vid, base: vpath(vid), origin: c.origin, appRoot, pkg, sweeps: !flag('no-sweeps'), exports: !flag('no-exports'), registry };
		await v5.load({});
		ctx.v5Nav = await v5Nav(v5);
		return { v5, app, selfV5, ctx };
	});
	for (const view of views) await guard(`view ${view}`, VIEW_MS, async () => {
		const tv = performance.now();
		let s5, sa;
		try { s5 = await extractV5View(v5, view, ctx); if (view === 'overview') s5.lists.navigation = ctx.v5Nav; }
		catch (e) { s5 = { ...emptySnapshot(view, 'v5', 'error'), error: String(e.message ?? e).slice(0, 500) }; }
		const a = adapters[view];
		if (selfV5) {
			try { sa = { ...(await extractV5View(selfV5, view, ctx)), side: 'app' }; if (view === 'overview') sa.lists.navigation = await v5Nav(selfV5); }
			catch (e) { sa = { ...emptySnapshot(view, 'app', 'error'), error: String(e.message ?? e).slice(0, 500) }; }
		} else if (a) {
			try { sa = await a.extract(app, ctx); for (const sw of Object.keys(s5.sweeps)) if (!sa.sweeps[sw]) sa.sweeps[sw] = a.sweeps?.[sw] ? await a.sweeps[sw](app, ctx) : undefined; for (const k of Object.keys(sa.sweeps)) if (sa.sweeps[k] === undefined) delete sa.sweeps[k]; }
			catch (e) { sa = { ...emptySnapshot(view, 'app', 'error'), error: String(e.stack ?? e).slice(0, 800) }; }
			sa = appFromAdapter(view, registry, sa, implemented);
		} else sa = appWithoutAdapter(view, registry, implemented);
		const r = classify(view, diff(s5, sa), reg.entries, { approvedOnly: flag('approved-only') });
		perView[view] = { ...r, v5Status: s5.status, appStatus: sa.status, ms: Math.round(performance.now() - tv) };
		details[view] = { view, v5Status: s5.status, v5Error: s5.error ?? null, appStatus: sa.status, appError: sa.error ?? null, owner: sa.owner ?? null, compared: r.compared, matched: r.matched, unregistered: r.unregistered, registered: r.registered };
		writeFileSync(at('views', `${view}.json`), JSON.stringify(details[view], null, 1));
		if (flag('keep-snapshots')) writeFileSync(at('views', `${view}.snapshots.json`), JSON.stringify({ v5: s5, app: sa }));
		const reg2 = TYPES.map((t) => [t, r.registered.filter((d) => d.type === t).length]).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ');
		console.log(`  ${view.padEnd(20)} v5 ${s5.status.padEnd(6)} app ${sa.status.padEnd(15)} compared ${String(r.compared).padStart(6)} matched ${String(r.matched).padStart(6)} registered ${r.registered.length}${reg2 ? ` (${reg2})` : ''} unregistered ${r.unregistered.length} ${perView[view].ms} ms`);
	});
	writeFileSync(at('v5-requests.json'), JSON.stringify({ network: [...v5.nonFile, ...(selfV5?.nonFile ?? [])], browserInternal: [...v5.internal, ...(selfV5?.internal ?? [])] }, null, 1) + '\n');
	details.__requests = { v5BrowserInternal: v5.internal.length + (selfV5?.internal.length ?? 0), v5NonFile: v5.nonFile.length + (selfV5?.nonFile.length ?? 0), appNonLoopback: app.requests.filter((u) => !/^(https?:\/\/(127\.0\.0\.1|[a-z0-9-]+\.localhost)(:\d+)?\/|data:|blob:|about:)/.test(u) && !BROWSER_INTERNAL.test(u)).length };
} catch (e) {
	const a = abortOf(e, 'the run');
	if (a) console.error(`parity: run aborted in ${a.step}: ${a.why}`);
	else console.error(`parity: ${e.setup ? 'setup error' : 'run aborted'}: ${e.stack ?? e}`);
	aborted = a?.record ?? { step: e.setup ? 'setup' : 'the run', cause: String(e.message ?? e).slice(0, 300), kind: e.setup ? 'setup' : 'error' };
	exitCode = 2;
	exitWithin(30_000, 2, 'parity');
} finally {
	await b?.close().catch(() => {});
	await srv?.stop().catch(() => {});
	await canary.close().catch(() => {});
}
const treeAfter = treeStamp(fx.caseFolder);
// Canary hits: Chromium's own Google service endpoints (GCM, component and time services) are browser background
// traffic, reported apart; page requests are caught through CDP above. Any other hit fails the run.
const SERVICE = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com|gvt2\.com)$/;
const serviceHits = canary.hits.filter((h) => SERVICE.test(String(h.sni ?? h.host ?? '').replace(/:\d+$/, '')));
const otherHits = canary.hits.length - serviceHits.length;
const used = new Set(Object.values(perView).flatMap((r) => r.registered.map((d) => d.register)));
const unused = unusedEntries(reg.entries, Object.keys(perView), used);
writeFileSync(at('canary-hits.json'), JSON.stringify(canary.hits, null, 1) + '\n');
writeFileSync(at('register-usage.json'), JSON.stringify({ used: [...used].sort(), unused, files: reg.files }, null, 1) + '\n');
const nonFile = details.__requests?.v5NonFile ?? null;
// every module the loaders list in a folder (they share moduleFiles) or imported, each of which must be committed; the
// register files and the modules are checked against the bytes the run read (loadRegister's, importModule's)
const modules = checkedModules([APP_ADAPTERS, SPEC_DIR, SLOTS_DIR]);
const nonEvidence = runNonEvidence({ register: opt('register'), appV5Html, loaded: reg.read, bytes: { ...reg.bytes, ...Object.fromEntries(IMPORTED) }, modules, noSweeps: flag('no-sweeps'), noExports: flag('no-exports'), maxCombos: process.env.PARITY_MAX_COMBOS });
// the fixture the verdict is about: the locator is local (case material), so its identities are recorded here
const fixture = { profile: relative(REPO, PROFILE), acceptedResultsVersion: fx.accepted.resultsVersion, baseResultsVersion: fx.acceptedBase.resultsVersion, diagnosticsSha256: fx.accepted.diagnosticsSha256, packageResultsVersion: pkg.manifest.resultsVersion, packageReused: pkgRun.reused, sha256: fx.sha256 };
const sc = scorecard(perView, {
	command: `bun run --bun parity -- ${argv.join(' ')}`, revision: git.head, dirty: git.dirty, build: { id: stamp.buildId, revision: stamp.revision, dirty: stamp.dirty ?? null, root: relative(REPO, appRoot) || '.' },
	...evidenceRecord(fresh, allowedStale, nonEvidence),
	fixture, clock, timezone, register: { entries: reg.entries.length, approved: reg.entries.filter((e) => e.approvedBy).length, approvedOnly: flag('approved-only'), used: used.size, unused: unused.length, strict: flag('strict-register') },
	appSide: opt('app-v5-html') ? 'v5 self-parity copy' : 'app build',
	isolation: { offline: proof.pass, links: proof.links, v5NonFileRequests: nonFile, v5BrowserInternalRequests: details.__requests?.v5BrowserInternal ?? null, appNonLoopbackRequests: details.__requests?.appNonLoopback ?? null, canaryHits: otherHits, canaryBrowserServiceHits: serviceHits.length, fixtureUnchanged: treeBefore === treeAfter },
	seconds: Math.round((performance.now() - t0) / 100) / 10,
});
// an aborted run proves nothing past the abort, whatever else its evidence record says
if (aborted) Object.assign(sc, { evidence: false, evidenceNote: sc.evidence ? `NOT release evidence: ${abortReason(aborted)}` : `${sc.evidenceNote}; ${abortReason(aborted)}` });
Object.assign(sc, { aborted, browser: b?.launch ?? null });
const failures = exitCode === 0 ? runFailures(sc, { views: views.length, unused: unused.length, strict: flag('strict-register') }) : [];
if (failures.length) { exitCode = 1; sc.result = 'FAIL'; console.error(`parity: FAIL: ${failures.join('; ')}`); }
sc.exit = exitCode;
writeFileSync(at('scorecard.json'), JSON.stringify(sc, null, 1) + '\n');
const T = sc.total;
writeFileSync(at('scorecard.md'), [
	`# Parity scorecard`, '',
	`Result **${sc.result}** (exit ${exitCode}) at ${git.head}${git.dirty ? ' (dirty)' : ''}; build ${stamp.buildId} from ${stamp.revision}; clock ${clock} ${timezone}; ${sc.seconds} s.`, '',
	`Evidence: ${sc.evidence ? 'yes (a fresh build of clean HEAD)' : `**no**: ${sc.evidenceNote}`}.`, '',
	`Fixture: package resultsVersion ${fixture.packageResultsVersion} (accepted ${fixture.acceptedResultsVersion}${fixture.packageReused ? '; reused package' : ''}); main HTML sha256 ${fixture.sha256.mainHtml} and expected examples ${fixture.sha256.expectedExamples} (pinned by ${fixture.profile}).`, '',
	`Views ${T.views}: v5 extracted ${T.viewsExtractedV5}, app compared ${T.viewsComparedApp}, not yet implemented ${T.viewsNotImplemented}, extraction errors ${T.viewsExtractError}, failed ${T.viewsFailed}. Values: v5 ${T.v5Values}, app ${T.appValues}, compared ${T.compared}, matched ${T.matched}. Registered differences: ${TYPES.map((t) => `${t} ${T.registered[t]}`).join(', ')} (${T.pendingApproval} on entries awaiting approval). Unregistered: ${T.unregistered}.`, '',
	`Register: ${reg.entries.length} entries (${sc.register.approved} approved); ${used.size} covered a difference, ${unused.length} unused in the views run${flag('strict-register') ? ' (strict: unused fails)' : ''}.`, '',
	`Isolation: offline ${proof.pass}, v5 non-file network requests ${nonFile} (browser-internal viewer requests ${sc.isolation.v5BrowserInternalRequests}), app non-loopback requests ${sc.isolation.appNonLoopbackRequests}, canary hits ${otherHits} (browser-service ${serviceHits.length}), fixture tree unchanged ${treeBefore === treeAfter}.`, '',
	'| View | Status | Compared | Matched | Registered | Pending approval | Unregistered |', '| --- | --- | --: | --: | --: | --: | --: |',
	...Object.entries(sc.views).map(([v, x]) => `| ${v} | ${x.status} | ${x.compared} | ${x.matched} | ${Object.values(x.registered).reduce((a, b) => a + b, 0)} | ${x.pendingApproval} | ${x.unregistered} |`), '',
].join('\n'));
console.log(`parity: ${sc.result} (exit ${exitCode})${evidenceSuffix(sc)}: ${T.views} views, ${T.compared} values compared, ${T.matched} matched, ${Object.values(T.registered).reduce((a, b) => a + b, 0)} registered, ${T.unregistered} unregistered; ${sc.seconds} s -> ${out}`);
process.exit(exitCode);
