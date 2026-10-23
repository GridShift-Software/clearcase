#!/usr/bin/env bun
// CC-05 (GRS-15) performance measurement of the analysis views, offline, on this host, against a production build
// under Bun with the REAL v5 sample imported and activated:
//
//   bun run --bun measure --ticket CC-05 [--candidate REV (default HEAD)] [--samples 28] [--warmup 2] [--out DIR]
//       [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// The revision under test is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs), never ./build. No
// baseline is built: the analysis views do not exist before GRS-15. Metrics, each >= 20 kept samples after --warmup
// discarded ones, nearest-rank percentiles (exit 1 if a budget fails or a metric has too few samples, 2 on a usage or
// prerequisite error):
//   warmNavigation  one warm tab: a mouse click on the navigation link of the next analysis view (event timeStamp) ->
//                   client-side navigation until main[data-ready=<view>] at the view's route, then the next rendered
//                   frame. The seven views are visited in turn. Budget p95 <= 200 ms.
//   expandedDetail  one warm tab on an analysis view: a mouse click on an evidence link of that view (a defence
//                   document chip, a contradiction source chip, a timeline event) -> the document detail rendered
//                   (main[data-ready=doc:<ref>]), then the next frame. Distinct links in turn. Budget p95 <= 200 ms.
//   pageErrors      uncaught exceptions and console errors on the measured pages. Budget 0. (Empty optional datasets
//                   are proved without errors by tests/e2e/analysis/suite.mjs, scenario AN-10, on synthetic data.)
// "Next rendered frame" as in cc03.mjs. Raw timings and the refs measured are case material: they go only to
// <out>/measure-CC-05.json (default $CLEARCASE_REPORT_DIR/measure, else .local/measure); this file holds no case values.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';
import { gitEnv } from '../browser-lock.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc05: ${m}\nusage: measure --ticket CC-05 [--candidate REV] [--samples 28] [--warmup 2] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-05') usage(`this runner measures CC-05, not ${a.ticket}`);
const SAMPLES = Number(a.samples ?? 28), WARMUP = Number(a.warmup ?? 2);
const MIN_SAMPLES = 20;
if (!Number.isInteger(SAMPLES) || SAMPLES < MIN_SAMPLES || !Number.isInteger(WARMUP) || WARMUP < 2) usage(`--samples must be an integer >= ${MIN_SAMPLES} and --warmup >= 2`);
const BUDGETS = { warmNavigation: 200, expandedDetail: 200 };
const VIEWS = ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'];
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc05-work'));
if (!(work + '/').startsWith(join(REPO, '.local') + '/')) usage(`--work ${work} must lie inside ${join(REPO, '.local')}`);

ensureOffline(import.meta.filename);
mkdirSync(out, { recursive: true });

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { startCanary } = await import('../../tests/e2e/pilot/lib/canary.mjs');
const { launch, newPage } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { isolatedBuild } = await import('../../tests/e2e/pilot/lib/isolated-build.mjs');
const { ConfigError, loadConfig, readPackage, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
const { VIEWS: REGISTRY } = await import('../../src/lib/components/view-registry.ts');

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc05: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc05: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const p0 = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${a.candidate ?? 'HEAD'}^{commit}`], { encoding: 'utf8', env: gitEnv() });
if (p0.status !== 0) usage(`unknown revision ${a.candidate}`);
const full = p0.stdout.trim();
const RV = fx.accepted.resultsVersion;
const route = (id) => REGISTRY.find((v) => v.id === id).route;

console.log("converting the v5 main HTML with GRS-10's converter ...");
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0) { console.error(`cc05: conversion failed: ${pkgRun.stderr}`); process.exit(1); }
const pkg = readPackage(pkgRun.dir);
if (pkg.manifest.resultsVersion !== RV) { console.error(`cc05: package resultsVersion ${pkg.manifest.resultsVersion} differs from the accepted ${RV}`); process.exit(1); }

const canary = await startCanary();
const result = {
	ticket: 'CC-05', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`,
	evidence: process.env.CLEARCASE_BUILD_EVIDENCE === 'true', worktree: gitIdentity(), host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	fixture: { sha256: fx.sha256, docCount: fx.summary.mainHtml.docCount, package: { resultsVersion: pkg.manifest.resultsVersion, convertMs: Math.round(pkgRun.ms) } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetsP95Ms: BUDGETS, nextFrame: 'a MutationObserver (installed before page scripts) sees the condition; the mark is taken in a task posted from the next requestAnimationFrame callback', clock: "click event timeStamp to the mark, the page's own performance.now()" },
};
let failure = null;
let srv = null, br = null;
try {
	console.log(`candidate: isolated build of ${full.slice(0, 12)} ...`);
	const b = isolatedBuild({ repo: REPO, rev: full, dir: join(work, `rev-${full.slice(0, 12)}`), log: (m) => console.log(m) });
	result.build = { revision: full, stamp: b.stamp, buildMs: Math.round(b.buildMs), lockSha256: b.lockSha256, mode: 'isolated copy (git archive + reflinked node_modules after bun.lock identity check, bun run --bun build)' };
	const port = PORTS.first + 50, origPort = port + 1;
	srv = await startServer({ root: b.src, port, origPort, dataDir: join(work, 'data'), buildDir: b.buildDir, logFile: join(out, `server-cc05-${full.slice(0, 12)}.log`), env: { CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z', TZ: 'UTC' } });
	const c = client(port);
	const origin = `http://127.0.0.1:${port}`;
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status} ${imp.text.slice(0, 500)}`);
	await c.activate(imp.importId, { ack: true });
	if ((await c.activeVersion()) !== RV) throw new Error('activation did not make the v5 sample active');

	br = await launch({ profileRoot: join(work, 'profiles') });
	const INIT = `(() => {
		const cc = window.__cc = { marks: {}, want: null, pending: false, t0: null };
		const check = () => { const w = cc.want; if (!w || cc.pending || cc.marks[w.key]) return; if (document.querySelector('main#main')?.dataset.ready === w.ready && location.pathname.endsWith(w.path)) { cc.pending = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.marks[w.key] = { at: performance.now(), seen, frame }; cc.pending = false; }; ch.port2.postMessage(0); }); } };
		cc.arm = (key, ready, path) => { cc.want = { key, ready, path }; cc.pending = false; delete cc.marks[key]; cc.t0 = null; };
		new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		document.addEventListener('click', (e) => { if (cc.want && cc.t0 === null) cc.t0 = e.timeStamp; }, true);
	})()`;
	const P = await newPage(br, { initScript: INIT });
	const mark0 = br.mark();
	const box = (sel) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	const click = async (xy) => { await P.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await P.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };
	const timed = async (key, sel, ready, path) => {
		const xy = await box(sel);
		if (!xy) throw new Error(`nothing to click for ${key} (${sel})`);
		await P.evaluate(`window.__cc.arm(${JSON.stringify(key)}, ${JSON.stringify(ready)}, ${JSON.stringify(path)})`);
		await click(xy);
		const m = await P.waitFor(`window.__cc.marks[${JSON.stringify(key)}] && window.__cc.t0 !== null && { ...window.__cc.marks[${JSON.stringify(key)}], t0: window.__cc.t0 }`, 30000);
		return { ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), frameMs: +(m.frame - m.t0).toFixed(1) };
	};
	const V = (id) => `${vpath(RV)}${route(id)}`;

	// warm navigation through the seven views, from each to the next by its navigation link
	console.log('warm navigation ...');
	await P.navigate(`${origin}${V(VIEWS[0])}`);
	await P.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(VIEWS[0])} && !!document.querySelector('main#main[data-hydrated]')`, 60000);
	const warm = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const to = VIEWS[(i + 1) % VIEWS.length];
		const t = await timed(`nav${i}`, `#nav-${to}`, to, route(to));
		warm.push({ i, warmup: i < WARMUP, view: to, ...t });
	}
	const fullLoads = await P.evaluate(`performance.getEntriesByType('navigation').length`);

	// expanded detail: evidence links of the analysis views to their documents, distinct links in turn
	console.log('expanded detail ...');
	const SOURCES = [['vdm_matrix_tab', '#defence-table a.cite'], ['contradictions_tab', 'section.category a.cite'], ['timeline', '#phases .ev a.cite']];
	const links = [];
	for (const [view, sel] of SOURCES) {
		await P.navigate(`${origin}${V(view)}`);
		await P.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(view)} && !!document.querySelector('main#main[data-hydrated]')`, 60000);
		const n = await P.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
		for (let k = 0; k < n; k++) links.push({ view, sel, k });
	}
	// interleave the three sources so every kind of link is measured, then take what the sample count needs
	const bySource = SOURCES.map(([v]) => links.filter((l) => l.view === v));
	const order = [];
	for (let k = 0; order.length < WARMUP + SAMPLES && bySource.some((l) => l.length > k); k++) for (const l of bySource) if (l[k]) order.push(l[k]);
	const detail = [];
	for (const [i, l] of order.slice(0, WARMUP + SAMPLES).entries()) {
		await P.navigate(`${origin}${V(l.view)}`);
		await P.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(l.view)} && !!document.querySelector('main#main[data-hydrated]')`, 60000);
		const ref = await P.evaluate(`(() => { const a = document.querySelectorAll(${JSON.stringify(l.sel)})[${l.k}]; a.setAttribute('data-cc05', '1'); return decodeURIComponent(a.getAttribute('href').replace(/^.*\\/doc\\//, '').replace(/\\?.*$/, '')); })()`);
		const t = await timed(`detail${i}`, '[data-cc05]', `doc:${ref}`, `/doc/${encodeURIComponent(ref)}`);
		detail.push({ i, warmup: i < WARMUP, from: l.view, ref, ...t });
	}
	const errors = br.since(mark0).console.filter((x) => x.kind === 'exception' || /error/i.test(x.kind));
	result.raw = { warmNavigation: warm, expandedDetail: detail, pageErrors: errors.map((e) => ({ kind: e.kind, text: e.text.slice(0, 200) })) };
	result.notes = { warmNavigationFullDocumentLoads: fullLoads, detailLinksAvailable: links.length };
	const kept = (xs) => xs.filter((x) => !x.warmup).map((x) => x.ms);
	result.metrics = {};
	for (const k of ['warmNavigation', 'expandedDetail']) {
		const s = stats(kept(result.raw[k]));
		result.metrics[k] = { ...s, discardedWarmup: result.raw[k].filter((x) => x.warmup).length, budgetP95Ms: BUDGETS[k], enoughSamples: s.n >= MIN_SAMPLES, pass: s.n >= MIN_SAMPLES && s.p95Ms <= BUDGETS[k] };
	}
	result.metrics.pageErrors = { n: errors.length, budget: 0, pass: errors.length === 0 };
	result.status = Object.values(result.metrics).every((m) => m.pass) ? 'PASS' : 'FAIL';
} catch (e) { failure = String(e?.stack ?? e); console.error(`cc05: ${failure}`); }
finally {
	await br?.close().catch(() => {});
	await srv?.stop().catch(() => {});
}
await canary.close().catch(() => {});
result.canaryHits = canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null }));
result.finishedAt = new Date().toISOString();
result.error = failure;
result.ok = !failure && result.status === 'PASS';
writeFileSync(join(out, 'measure-CC-05.json'), JSON.stringify(result, null, 1));
if (result.metrics) {
	console.log(`\nCC-05 ${full.slice(0, 12)} (build ${result.build?.stamp?.buildId}); fixture ${result.fixture.docCount} documents; evidence: ${result.evidence}`);
	for (const [k, m] of Object.entries(result.metrics)) console.log(`${k.padEnd(15)} ${'p95Ms' in m ? `n=${m.n} p50 ${m.p50Ms} p95 ${m.p95Ms} max ${m.maxMs} ms (budget p95 <= ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})` : `n=${m.n} (budget ${m.budget}: ${m.pass ? 'PASS' : 'FAIL'})`}`);
}
if (!a.keep) rmSync(work, { recursive: true, force: true });
console.log(`measure CC-05: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-05.json')}`);
process.exit(result.ok ? 0 : 1);
