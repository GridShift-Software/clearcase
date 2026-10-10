#!/usr/bin/env bun
// CC-09 (GRS-19) performance measurement of the bundle views, offline, on this host, against the production build of
// the revision under test (an isolated copy, never ./build) under Bun with the REAL v5 sample imported and activated:
//
//   bun run --bun measure --ticket CC-09 --candidate REV [--samples 20] [--warmup 2] [--out DIR]
//       [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// Metrics, each >= --samples kept samples after --warmup discarded ones; percentiles are nearest-rank:
//   selection      Discovery Schedule: mouse click on a file's checkbox (event timeStamp) -> the selection rendered
//                  (#ds-count shows the new count, the box is ticked and its row highlighted), then the next rendered
//                  frame. Distinct files. Budget p95 <= 200 ms (gated). The save that follows is recorded too
//                  (click -> main[data-pending="0"]), not gated.
//   coverExport    Download cover page (uncertified): click -> the Blob anchor download is handed to the browser.
//                  Baseline, not gated (no CC-01 figure exists).
//   wordIndexes    Court Bundle, All indexes (Word): click -> the DOCX download is handed to the browser. Baseline.
//   largeDocPage   CaseLines, Open in app: click -> the large pleadings original's document page shows its original
//                  state and Open link. Baseline.
//   largeDocViewer that Open link (the isolated viewer at the original) in a new tab: navigation start -> the
//                  viewer's first page (body[data-ready=1], its readyMs). Baseline (CC-03 budgets 500 ms for cited PDFs).
// "Next rendered frame": a MutationObserver installed before page scripts sees the condition; the mark is taken in a
// task posted from the next requestAnimationFrame callback. Raw timings go to <out>/measure-CC-09.json (default
// $CLEARCASE_REPORT_DIR/measure, else .local/measure); they hold refs and sizes of the sample, which are case
// material and stay there. This file and its console output hold no case values.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc09: ${m}\nusage: measure --ticket CC-09 --candidate REV [--samples 20] [--warmup 2] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-09') usage(`this runner measures CC-09, not ${a.ticket}`);
if (!a.candidate) usage('--candidate is required (the revision under test, built in an isolated copy)');
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || !Number.isInteger(WARMUP) || WARMUP < 0) usage('--samples and --warmup must be non-negative integers');
const MIN_SAMPLES = 20;
const BUDGETS = { selection: 200 };
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc09-work'));
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

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc09: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc09: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const full = (() => { const p = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${a.candidate}^{commit}`], { encoding: 'utf8' }); if (p.status !== 0) usage(`unknown revision ${a.candidate}`); return p.stdout.trim(); })();
const RV = fx.accepted.resultsVersion;

console.log('converting the v5 main HTML with GRS-10\'s converter ...');
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0) { console.error(`cc09: conversion failed: ${pkgRun.stderr}`); process.exit(1); }
const pkg = readPackage(pkgRun.dir);
if (pkg.manifest.resultsVersion !== RV) { console.error(`cc09: package resultsVersion differs from the accepted one`); process.exit(1); }
const ds = (k) => { try { return pkg.dataset(k)?.data ?? null; } catch { return null; } };
const sched = ds('discovery-schedules'), cl = ds('caselines-index'), bundles = ds('bundles');
const fixtureSize = {
	documents: pkg.chronology.length,
	scheduleItems: sched ? sched.discovery.length + sched.supplementary.length : null,
	scheduleFiles: sched ? [...sched.discovery, ...sched.supplementary].reduce((n, i) => n + i.files.length, 0) : null,
	caselinesPages: cl ? cl.index.length : null,
	bundles: bundles ? bundles.list.length : null,
	bundleRows: bundles ? bundles.list.reduce((n, b) => n + b.rows.length, 0) : null,
};

const canary = await startCanary();
const result = {
	ticket: 'CC-09', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`,
	worktree: gitIdentity(), host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	fixture: { sha256: fx.sha256, size: fixtureSize, package: { resultsVersion: pkg.manifest.resultsVersion, convertMs: Math.round(pkgRun.ms) } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetsP95Ms: BUDGETS, baselines: 'coverExport, wordIndexes, largeDocPage and largeDocViewer are recorded as baselines; CC-01 recorded no export or large-document figures, so no speedup is claimed' },
};
let failure = null;
const raw = {};
let srv, br;
try {
	console.log(`candidate: isolated build of ${full.slice(0, 12)} ...`);
	const b = isolatedBuild({ repo: REPO, rev: full, dir: join(work, `rev-${full.slice(0, 12)}`), log: (m) => console.log(m) });
	result.build = { stamp: b.stamp, buildMs: Math.round(b.buildMs), lockSha256: b.lockSha256, mode: 'isolated copy (git archive + reflinked node_modules, bun run --bun build)' };
	const port = PORTS.first + 40, origPort = port + 1;
	srv = await startServer({ root: b.src, port, origPort, dataDir: join(work, 'data'), buildDir: b.buildDir, logFile: join(out, 'server-cc09.log'), env: { CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z' } });
	const c = client(port);
	const origin = `http://127.0.0.1:${port}`;
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status}`);
	await c.activate(imp.importId, { ack: true });
	if ((await c.activeVersion()) !== RV) throw new Error('activation did not make the v5 sample active');
	const V = `${origin}${vpath(RV)}`;

	br = await launch({ profileRoot: join(work, 'profiles') });
	const INIT = `(() => {
		const cc = window.__cc = { marks: {}, armed: {}, pending: {}, t0: null, dl: [] };
		const conds = { select: () => { const x = cc.expect; if (!x) return false; const cb = document.querySelector('[data-cc-target] input[type=checkbox]'); return document.getElementById('ds-count')?.textContent.trim() === x && !!cb?.checked && !!cb.closest('tr')?.classList.contains('sel'); } };
		const check = () => { for (const k in conds) if (cc.armed[k] && !cc.pending[k] && conds[k]()) { cc.pending[k] = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.marks[k] = { at: performance.now(), seen, frame }; }; ch.port2.postMessage(0); }); } };
		cc.arm = (k, expect) => { delete cc.marks[k]; delete cc.pending[k]; cc.armed[k] = true; cc.expect = expect; cc.t0 = null; };
		new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		document.addEventListener('click', (e) => { cc.t0 = e.timeStamp; }, true);
		const C = URL.createObjectURL.bind(URL); const blobs = new Map();
		URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
		const click = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { cc.dl.push({ at: performance.now(), size: o.size }); return; } return click.call(this); };
	})()`;
	const P = await newPage(br, { initScript: INIT });
	const box = (sel) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	const click = async (sel) => { const xy = await box(sel); if (!xy) throw new Error(`no ${sel}`); await P.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await P.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };
	const N = WARMUP + SAMPLES;

	// selection
	console.log('selection ...');
	await P.navigate(`${V}/bundles/discovery_tab`);
	await P.waitFor(`document.querySelector('main[data-ready="discovery_tab"]')`, 60000);
	if ((await P.evaluate(`document.getElementById('ds-count').textContent.trim()`)) !== '0') { await click('#ds-clear'); await P.waitFor(`document.querySelector('#main').dataset.pending === '0' && document.getElementById('ds-count').textContent.trim() === '0'`, 30000); }
	raw.selection = [];
	for (let i = 0; i < N; i++) {
		await P.evaluate(`(() => { document.querySelectorAll('[data-cc-target]').forEach((e) => e.removeAttribute('data-cc-target')); const chips = [...document.querySelectorAll('#ds-list .ds-chip')].filter((c) => !c.querySelector('input').checked); chips[${i * 3}]?.setAttribute('data-cc-target', '1'); })()`);
		const expect = String(Number(await P.evaluate(`document.getElementById('ds-count').textContent.trim()`)) + 1);
		await P.evaluate(`window.__cc.arm('select', ${JSON.stringify(expect)})`);
		await click('[data-cc-target] input[type=checkbox]');
		const m = await P.waitFor(`window.__cc.marks.select && window.__cc.t0 !== null && { at: window.__cc.marks.select.at, seen: window.__cc.marks.select.seen, t0: window.__cc.t0 }`, 30000);
		await P.waitFor(`document.querySelector('#main').dataset.pending === '0'`, 30000);
		const saved = await P.evaluate('performance.now()');
		raw.selection.push({ i, warmup: i < WARMUP, ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), savedWithinMs: +(saved - m.t0).toFixed(1) });
	}
	await click('#ds-clear');
	await P.waitFor(`document.querySelector('#main').dataset.pending === '0'`, 60000);

	// exports: one click -> the Blob download handed over
	const exportSeries = async (path, ready, sel) => {
		await P.navigate(`${V}${path}`);
		await P.waitFor(`document.querySelector('main[data-ready="${ready}"]')`, 60000);
		const xs = [];
		for (let i = 0; i < N; i++) {
			await P.evaluate('window.__cc.dl = []; window.__cc.t0 = null');
			await click(sel);
			const d = await P.waitFor(`window.__cc.dl.length && window.__cc.t0 !== null && { at: window.__cc.dl[0].at, t0: window.__cc.t0, size: window.__cc.dl[0].size, n: window.__cc.dl.length }`, 60000);
			xs.push({ i, warmup: i < WARMUP, ms: +(d.at - d.t0).toFixed(1), bytes: d.size, downloads: d.n });
		}
		return xs;
	};
	console.log('exports ...');
	raw.coverExport = await exportSeries('/bundles/discovery_tab', 'discovery_tab', '#ds-cover-dl');
	raw.wordIndexes = await exportSeries('/bundles/court_bundle_tab', 'court_bundle_tab', '#cb-word-all');

	// the large pleadings original: its document page from CaseLines, then the viewer's first page
	console.log('large document ...');
	raw.largeDocPage = [];
	let viewer = null;
	for (let i = 0; i < N; i++) {
		await P.navigate(`${V}/bundles/caselines_tab`);
		await P.waitFor(`document.querySelector('main[data-ready="caselines_tab"]')`, 60000);
		if (!(await P.evaluate(`!!document.getElementById('cl-open')`))) throw new Error('the CaseLines original does not resolve to a document of the version');
		await P.evaluate('window.__cc.t0 = null');
		await click('#cl-open');
		const m = await P.waitFor(`location.pathname.includes('/doc/') && document.getElementById('original-state') && window.__cc.t0 !== null && { at: performance.now(), t0: window.__cc.t0, href: document.getElementById('open-original')?.getAttribute('href') ?? null, route: document.querySelector('#original-state .route')?.dataset.route ?? null }`, 60000);
		viewer = m.href;
		raw.largeDocPage.push({ i, warmup: i < WARMUP, ms: +(m.at - m.t0).toFixed(1), route: m.route });
	}
	if (!viewer) throw new Error('the large original has no viewer link');
	raw.largeDocViewer = [];
	for (let i = 0; i < N; i++) {
		const t = await newPage(br);
		try {
			await t.navigate(viewer, { waitLoad: false });
			const st = await t.waitFor(`document.body && (document.body.dataset.ready === '1' || document.body.dataset.ready === 'error') ? { ready: document.body.dataset.ready, readyMs: Number(document.body.dataset.readyMs) } : null`, 180000);
			if (st.ready !== '1') throw new Error(`the viewer reported ${st.ready}`);
			raw.largeDocViewer.push({ i, warmup: i < WARMUP, ms: st.readyMs });
		} finally { await t.close(); }
	}
	const largest = pkg.chronology.map((r) => ({ ref: r.ref, ...pkg.assets[r.ref] })).filter((x) => x.kind === 'file' && x.mediaType === 'application/pdf').sort((p, q) => q.size - p.size)[0];
	result.largeDocument = { note: 'the CaseLines source original, opened from the CaseLines view', largestPdfBytesInRegister: largest?.size ?? null };
} catch (e) { failure = String(e?.stack ?? e); console.error(`cc09: ${failure}`); }
await br?.close().catch(() => {});
await srv?.stop().catch(() => {});
await canary.close().catch(() => {});
result.canaryHits = canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null }));
const kept = (xs) => (xs ?? []).filter((x) => !x.warmup).map((x) => x.ms);
result.raw = raw;
result.metrics = {};
for (const k of ['selection', 'coverExport', 'wordIndexes', 'largeDocPage', 'largeDocViewer']) {
	const s = stats(kept(raw[k]));
	const budget = BUDGETS[k] ?? null;
	result.metrics[k] = { ...s, discardedWarmup: (raw[k] ?? []).filter((x) => x.warmup).length, budgetP95Ms: budget, gated: budget !== null, enoughSamples: s.n >= MIN_SAMPLES, pass: budget === null ? null : s.n >= MIN_SAMPLES && s.p95Ms <= budget };
}
result.metrics.selection.savedWithin = stats((raw.selection ?? []).filter((x) => !x.warmup).map((x) => x.savedWithinMs));
result.error = failure;
result.ok = !failure && Object.values(result.metrics).every((m) => m.enoughSamples && m.pass !== false) && result.canaryHits.length === 0;
result.finishedAt = new Date().toISOString();
writeFileSync(join(out, 'measure-CC-09.json'), JSON.stringify(result, null, 1));
console.log(`\nCC-09 candidate ${full.slice(0, 12)} (build ${result.build?.stamp?.buildId ?? '?'}); fixture ${JSON.stringify(fixtureSize)}`);
for (const [k, m] of Object.entries(result.metrics)) console.log(`${k.padEnd(15)} n=${m.n} p50 ${m.p50Ms} p95 ${m.p95Ms} max ${m.maxMs} ms${m.gated ? ` (budget p95 <= ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})` : ' (baseline, not gated)'}`);
if (!a.keep) rmSync(work, { recursive: true, force: true });
console.log(`measure CC-09: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-09.json')}`);
process.exit(result.ok ? 0 : 1);
