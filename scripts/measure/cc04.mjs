#!/usr/bin/env bun
// CC-04 (GRS-14) performance measurement of the evidence views, offline, on this host, against a production build
// under Bun with the REAL v5 sample imported and activated in a temporary data directory:
//
//   bun run --bun measure --ticket CC-04 [--candidate REV (default HEAD)] [--samples 20] [--warmup 2] [--out DIR]
//       [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// The revision under test is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs); ./build is never
// measured. No baseline is built. Metrics (nearest-rank p95 over >= --samples kept samples after --warmup discarded
// ones; exit 1 if a budget fails or a metric has fewer than 20 kept samples, 2 on a usage or prerequisite error):
//   search          one warm Advanced Search tab: a mouse click on Search (the click event's timeStamp) -> the
//                   submitted search's results rendered: main[data-search] names it, data-result is results or empty,
//                   no navigation pending, then the next rendered frame. Each sample submits another generic probe
//                   (a short text, alone or with the first bundle), so every sample is a real search. Budget p95 <= 300 ms.
//   warmNavigation  one warm tab, after one unmeasured lap over the seven evidence views (their code loaded once): a
//                   mouse click on the next evidence view's sidebar link -> main[data-ready=<view>] on that route with
//                   no navigation pending, then the next rendered frame. Budget p95 <= 200 ms.
//   corpusReloads   requests for the whole register (/api/v/<rv>/chronology) made while the search samples ran, and
//                   the bytes each search transferred: 0 whole-corpus reloads per filter change is the budget.
// "Next rendered frame" as in cc03.mjs: a MutationObserver installed before page scripts sees the condition; the mark
// is taken in a task posted from the next requestAnimationFrame callback. Raw timings go to <out>/measure-CC-04.json
// (default $CLEARCASE_REPORT_DIR/measure, else .local/measure). The fixture is case material: only counts are printed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc04: ${m}\nusage: measure --ticket CC-04 [--candidate REV] [--samples 20] [--warmup 2] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-04') usage(`this runner measures CC-04, not ${a.ticket}`);
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || !Number.isInteger(WARMUP) || WARMUP < 0) usage('--samples and --warmup must be non-negative integers');
const MIN_SAMPLES = 20;
const BUDGETS = { search: 300, warmNavigation: 200 };
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc04-work'));
if (!(work + '/').startsWith(join(REPO, '.local') + '/')) usage(`--work ${work} must lie inside ${join(REPO, '.local')}`);

ensureOffline(import.meta.filename);
mkdirSync(out, { recursive: true });

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { startCanary } = await import('../../tests/e2e/pilot/lib/canary.mjs');
const { launch, newPage } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { isolatedBuild } = await import('../../tests/e2e/pilot/lib/isolated-build.mjs');
const { isBackground } = await import('../../tests/e2e/pilot/suite/context.mjs');
const { ConfigError, loadConfig, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc04: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc04: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const rev = (r) => { const p = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${r}^{commit}`], { encoding: 'utf8' }); if (p.status !== 0) usage(`unknown revision ${r}`); return p.stdout.trim(); };
const full = rev(a.candidate ?? 'HEAD');
const RV = fx.accepted.resultsVersion;

console.log('converting the v5 main HTML with GRS-10\'s converter ...');
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0) { console.error(`cc04: conversion failed: ${pkgRun.stderr}`); process.exit(1); }

/** The seven evidence views, in sidebar order, as the measured lap visits them. */
const VIEWS = [['documents', '/evidence/documents'], ['contracts_tab', '/evidence/contracts_tab'], ['filings_tab', '/evidence/filings_tab'], ['search', '/evidence/search'], ['people', '/evidence/people'], ['entity_ledger_tab', '/evidence/entity_ledger_tab'], ['hoa_diff_tab', '/evidence/hoa_diff_tab']];
/** Generic search probes: no case wording. Each sample is a different submitted search. */
const PROBES = ['e', 'a', 'o', 'i', 're', 'pdf', 'the', 'to', 'an', 'in', 'on', 'at', 'of', 'st'];

const INIT = `(() => {
	const cc = window.__cc = { mark: null, want: null, t0: null };
	const met = () => { const m = document.querySelector('main#main'); if (!m || m.dataset.busy || !cc.want) return false;
		if (cc.want.kind === 'search') return m.dataset.search === cc.want.search && (m.dataset.result === 'results' || m.dataset.result === 'empty');
		return m.dataset.ready === cc.want.view && location.pathname.endsWith(cc.want.route); };
	let pending = false;
	const check = () => { if (!pending && cc.want && !cc.mark && met()) { pending = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.mark = { at: performance.now(), seen, frame }; pending = false; }; ch.port2.postMessage(0); }); } };
	cc.arm = (want) => { cc.want = want; cc.mark = null; cc.t0 = null; pending = false; };
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	document.addEventListener('click', (e) => { if (cc.want && cc.t0 === null) cc.t0 = e.timeStamp; }, true);
})()`;

const result = {
	ticket: 'CC-04', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`,
	worktree: gitIdentity(), host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	fixture: { sha256: fx.sha256, docCount: fx.summary.mainHtml.docCount, package: { resultsVersion: RV, convertMs: Math.round(pkgRun.ms) } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetsP95Ms: BUDGETS, corpusReloadBudget: 0, clock: 'the click event timeStamp to the mark, both on the page clock' },
};
let failure = null;
const canary = await startCanary();
let srv, br;
try {
	console.log(`candidate: isolated build of ${full.slice(0, 12)} ...`);
	const b = isolatedBuild({ repo: REPO, rev: full, dir: join(work, `rev-${full.slice(0, 12)}`), log: (m) => console.log(m) });
	result.build = { revision: full, stamp: b.stamp, buildMs: Math.round(b.buildMs), mode: 'isolated copy (git archive + reflinked node_modules after bun.lock identity check, bun run --bun build)' };
	const port = PORTS.first + 40, origPort = port + 1;
	srv = await startServer({ root: b.src, port, origPort, dataDir: join(work, 'data'), buildDir: b.buildDir, logFile: join(out, `server-cc04-${full.slice(0, 12)}.log`) });
	const c = client(port);
	const origin = `http://127.0.0.1:${port}`;
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status}`);
	await c.activate(imp.importId, { ack: true });
	if ((await c.activeVersion()) !== RV) throw new Error('activation did not make the v5 sample active');
	const base = `${origin}${vpath(RV)}`;
	br = await launch({ profileRoot: join(work, 'profiles') });
	const P = await newPage(br, { initScript: INIT });
	await P.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
	const reqs = [];
	br.on((m) => { if (m.sessionId === P.sessionId && m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url); });
	const box = (sel) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	const click = async (xy) => { await P.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await P.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };
	const measured = async (want, sel) => {
		await P.evaluate(`window.__cc.arm(${JSON.stringify(want)})`);
		const xy = await box(sel);
		if (!xy) throw new Error(`no ${sel}`);
		await click(xy);
		const m = await P.waitFor(`window.__cc.mark && window.__cc.t0 !== null && { at: window.__cc.mark.at, seen: window.__cc.mark.seen, frame: window.__cc.mark.frame, t0: window.__cc.t0 }`, 30000);
		return { ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), frameMs: +(m.frame - m.t0).toFixed(1) };
	};

	// search: one warm tab on Advanced Search, each sample another submitted probe
	console.log('search ...');
	await P.navigate(`${base}/evidence/search`);
	await P.waitFor(`document.querySelector('main#main')?.dataset.ready === 'search' && document.querySelector('main#main')?.dataset.hydrated === '1'`, 30000);
	const bundles = await P.evaluate(`[...document.getElementById('sb').options].map((o) => o.value).filter(Boolean)`);
	const combos = [];
	for (const bundle of ['', bundles[0] ?? '']) for (const q of PROBES) combos.push({ q, bundle });
	const FIELDS = ['q', 'bundle', 'type', 'sender', 'from', 'to', 'amin', 'amax', 'status'];
	const search = [];
	const corpus = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const c0 = combos[i % combos.length];
		await P.evaluate(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }; for (const id of ['sq', 'sb', 'st', 'ss', 'sf', 'sto', 'samin', 'samax', 'sst']) set(id, ''); set('sq', ${JSON.stringify(c0.q)}); set('sb', ${JSON.stringify(c0.bundle)}); })()`);
		const want = new URLSearchParams(FIELDS.map((k) => [k, k === 'q' ? c0.q : k === 'bundle' ? c0.bundle : ''])).toString();
		const r0 = reqs.length;
		const m = await measured({ kind: 'search', search: want }, '#search-run');
		const got = await P.evaluate(`({ result: document.querySelector('main#main').dataset.result, shown: document.querySelectorAll('#search-table tbody tr').length })`);
		const urls = reqs.slice(r0);
		const reload = urls.filter((u) => /\/api\/v\/[^/]+\/chronology/.test(u)).length;
		corpus.push(reload);
		search.push({ i, warmup: i < WARMUP, ...m, result: got.result, rowsShown: got.shown, requests: urls.length, corpusReloads: reload });
	}
	const searchBytes = await P.evaluate(`performance.getEntriesByType('resource').filter((e) => e.name.includes('__data.json')).map((e) => e.transferSize)`);

	// warm navigation: one unmeasured lap loads every evidence view's code, then click from view to view
	console.log('warm navigation ...');
	await P.navigate(`${base}/evidence/documents`);
	await P.waitFor(`document.querySelector('main#main')?.dataset.ready === 'documents' && document.querySelector('main#main')?.dataset.hydrated === '1'`, 30000);
	const lap = [];
	let at = 0;
	for (let k = 1; k <= VIEWS.length; k++) {
		const [view, route] = VIEWS[k % VIEWS.length];
		lap.push({ view, ...(await measured({ kind: 'view', view, route }, `#nav-${view}`)) });
		at = k % VIEWS.length;
	}
	const nav = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		at = (at + 1) % VIEWS.length;
		const [view, route] = VIEWS[at];
		nav.push({ i, warmup: i < WARMUP, view, ...(await measured({ kind: 'view', view, route }, `#nav-${view}`)) });
	}
	const fullLoads = await P.evaluate(`performance.getEntriesByType('navigation').length`);

	const kept = (xs) => xs.filter((x) => !x.warmup).map((x) => x.ms);
	result.raw = { search, warmNavigation: nav, firstLap: lap };
	result.metrics = {};
	for (const k of ['search', 'warmNavigation']) {
		const s = stats(kept(result.raw[k]));
		result.metrics[k] = { ...s, discardedWarmup: result.raw[k].filter((x) => x.warmup).length, budgetP95Ms: BUDGETS[k], enoughSamples: s.n >= MIN_SAMPLES, pass: s.n >= MIN_SAMPLES && s.p95Ms <= BUDGETS[k] };
	}
	result.metrics.corpusReloads = { searches: corpus.length, total: corpus.reduce((x, y) => x + y, 0), budget: 0, pass: corpus.every((n) => n === 0), dataBytesPerSearch: stats(searchBytes) };
	result.notes = { fullDocumentLoadsDuringWarmNavigation: fullLoads, firstLapMs: lap.map((x) => ({ view: x.view, ms: x.ms })), searchProbes: combos.length };
} catch (e) { failure = String(e?.stack ?? e); console.error(`cc04: ${failure}`); }
await br?.close().catch(() => {});
await srv?.stop().catch(() => {});
await canary.close().catch(() => {});
// a request by Chromium's own background services (no page origin or referer) is counted apart, as the suites do
result.canaryHits = canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null, browserBackground: isBackground(h) }));
result.finishedAt = new Date().toISOString();
result.error = failure;
result.evidence = process.env.CLEARCASE_BUILD_EVIDENCE === 'true';
result.ok = !failure && !!result.metrics && Object.values(result.metrics).every((m) => m.pass !== false && m.enoughSamples !== false) && result.canaryHits.every((h) => h.browserBackground);
writeFileSync(join(out, 'measure-CC-04.json'), JSON.stringify(result, null, 1));
if (result.metrics) {
	console.log(`\nCC-04 candidate ${full.slice(0, 12)} (build ${result.build?.stamp?.buildId ?? '?'}); fixture ${result.fixture.docCount} documents`);
	for (const k of ['search', 'warmNavigation']) { const m = result.metrics[k]; console.log(`${k.padEnd(15)} n=${m.n} p50 ${m.p50Ms} p95 ${m.p95Ms} max ${m.maxMs} ms (budget p95 <= ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})`); }
	const c = result.metrics.corpusReloads;
	console.log(`corpusReloads   ${c.total} whole-register requests over ${c.searches} searches (budget 0: ${c.pass ? 'PASS' : 'FAIL'}); data per search p95 ${c.dataBytesPerSearch.p95Ms ?? '?'} bytes`);
}
if (!a.keep) rmSync(work, { recursive: true, force: true });
console.log(`measure CC-04: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-04.json')}`);
process.exit(result.ok ? 0 : 1);
