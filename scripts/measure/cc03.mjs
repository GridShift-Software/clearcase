#!/usr/bin/env bun
// CC-03 (GRS-12) performance measurement of the local pilot, offline, on this host, against production builds under
// Bun with the REAL v5 sample imported and activated:
//
//   bun run --bun measure --ticket CC-03 --baseline REV --candidate REV [--samples 20] [--warmup 2] [--out DIR]
//       [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// Each revision is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs: git archive + reflinked
// node_modules after a bun.lock identity check, `bun run --bun build`); the worktree is never checked out. A revision
// without the pilot app (no scripts/pilot/start.ts) is reported as N/A. Metrics, each >= --samples samples after
// --warmup discarded samples (exit 1 if any budget fails or any metric has fewer samples; 2 on a usage or
// prerequisite error):
//   coldOverview   fresh browser context per sample: navigation start -> #count-documents shows the reference count
//                  AND main[data-ready=overview], then the next rendered frame. Budget p95 <= 2,000 ms.
//   warmNavigation one warm tab: click on the Chronology link (event timeStamp) -> client-side navigation until
//                  main[data-ready=chronology] and #row-count shows the reference count, then the next frame.
//                  Budget p95 <= 200 ms (gated).
//   pdfFirstPage   distinct representative PDF originals (sizes spread, the largest included), the viewer URL taken
//                  from the document page's Open link, opened in a new tab: navigation start -> wrapper
//                  body[data-ready=1] (body.dataset.readyMs, ms since the wrapper's navigation start). Budget p95 <= 500.
//                  Supplement (not gated): the 8 largest PDFs, one sample each, to show the size dependence.
//   downloadStart  distinct download-only originals: mouse click on #download-original -> Browser.downloadWillBegin
//                  (runner clock). Budget p95 <= 300 ms.
//   processStart   spawn of `bun scripts/pilot/start.ts` on the activated data directory -> /api/health answering
//                  from that PID. Reported, not gated.
// "Next rendered frame": a MutationObserver installed before any page script sees the condition become true; the
// next requestAnimationFrame callback posts a task (MessageChannel) that runs after that frame's rendering step, and
// the mark is taken there (raw samples also keep the condition time and the frame start). Percentiles
// are nearest-rank. Raw timings, identities and the cache policy go to <out>/measure-CC-03.json (default
// $CLEARCASE_REPORT_DIR/measure, else .local/agent-d/measure). Refs, sizes and paths of the sample are case material:
// they are written only there; this file holds no case values.
//
// Isolation: outside the network namespace the runner re-execs itself through tests/e2e/pilot/offline.sh (see
// tests/e2e/pilot/v5/env.mjs) and proves inside that it is offline; there is no online fallback.
//
// Fail fast (tests/e2e/pilot/lib/lifecycle.mjs): each revision's browser launch (2 min) and each phase (cold overview,
// warm navigation, PDF first page, download start: 15 min each; a phase takes well under a minute) run under a
// deadline and end at once when Chromium exits or a page crashes. The run then stops with exit 1, naming the phase and
// the cause, and measure-CC-03.json records `aborted` and `evidence: false`; `browser` records each launch.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';
import { gitEnv } from '../browser-lock.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc03: ${m}\nusage: measure --ticket CC-03 --baseline REV --candidate REV [--samples 20] [--warmup 2] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-03') usage(`this runner measures CC-03, not ${a.ticket}`);
if (!a.baseline || !a.candidate) usage('--baseline and --candidate are required');
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || !Number.isInteger(WARMUP) || WARMUP < 0) usage('--samples and --warmup must be non-negative integers');
const MIN_SAMPLES = 20;
const LARGEST = 8;
const BUDGETS = { coldOverview: 2000, warmNavigation: 200, pdfFirstPage: 500, downloadStart: 300 };
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'agent-d', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'agent-d', 'cc03-work'));
if (!(work + '/').startsWith(join(REPO, '.local') + '/')) usage(`--work ${work} must lie inside ${join(REPO, '.local')}`);

ensureOffline(import.meta.filename);
mkdirSync(out, { recursive: true });

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { startCanary } = await import('../../tests/e2e/pilot/lib/canary.mjs');
const { launch, newPage } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { abortOf, abortReason, deadline, exitWithin, guard } = await import('../../tests/e2e/pilot/lib/lifecycle.mjs');
const PHASE_MS = deadline(15 * 60_000);
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { isolatedBuild } = await import('../../tests/e2e/pilot/lib/isolated-build.mjs');
const { ConfigError, loadConfig, readPackage, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
const { attrById, nextDownload } = await import('../../tests/e2e/pilot/v5/browser.mjs');

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc03: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc03: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const git = gitIdentity();
const rev = (r) => { const p = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${r}^{commit}`], { encoding: 'utf8', env: gitEnv() }); if (p.status !== 0) usage(`unknown revision ${r}`); return p.stdout.trim(); };
const hasApp = (full) => spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${full}:scripts/pilot/start.ts`], { env: gitEnv() }).status === 0;
const RV = fx.accepted.resultsVersion;
const N = fx.summary.mainHtml.docCount;
const NTEXT = N.toLocaleString('en');

console.log('converting the v5 main HTML with GRS-10\'s converter ...');
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0) { console.error(`cc03: conversion failed: ${pkgRun.stderr}`); process.exit(1); }
const pkg = readPackage(pkgRun.dir);
if (pkg.manifest.resultsVersion !== RV) { console.error(`cc03: package resultsVersion ${pkg.manifest.resultsVersion} differs from GRS-10's accepted ${RV}`); process.exit(1); }

// ---- the measured originals: spread over sizes, the largest included (deterministic) ---------------------------------
const files = pkg.chronology.map((r) => ({ ref: r.ref, ...pkg.assets[r.ref] })).filter((x) => x.kind === 'file');
const INLINE = new Set(['application/pdf', 'message/rfc822', 'image/jpeg']);
function spread(xs, n) {
	const s = [...xs].sort((p, q) => p.size - q.size || (p.ref < q.ref ? -1 : 1));
	if (s.length <= n) return s;
	if (n <= 0) return [];
	if (n === 1) return [s[Math.floor(s.length / 2)]];
	const idx = new Set();
	for (let i = 0; i < n; i++) idx.add(Math.round((i * (s.length - 1)) / (n - 1)));
	for (let j = s.length - 1; idx.size < n; j--) idx.add(j);
	return [...idx].sort((p, q) => p - q).map((i) => s[i]);
}
const pick = (xs, n, w) => { const main = spread(xs, n); const used = new Set(main.map((x) => x.ref)); const rest = xs.filter((x) => !used.has(x.ref)); return { warm: spread(rest, w), main }; };
const pdfSet = pick(files.filter((x) => x.mediaType === 'application/pdf'), SAMPLES, WARMUP);
const dlSet = pick(files.filter((x) => !INLINE.has(x.mediaType)), SAMPLES, WARMUP);

// ---- one revision --------------------------------------------------------------------------------------------------
async function measureRevision(label, full, portBase) {
	const r = { label, revision: full, app: hasApp(full) };
	if (!r.app) { r.status = 'N/A'; r.reason = `${full} has no pilot app (scripts/pilot/start.ts is absent)`; console.log(`${label} ${full.slice(0, 12)}: N/A (${r.reason})`); return r; }
	console.log(`${label}: isolated build of ${full.slice(0, 12)} ...`);
	const b = isolatedBuild({ repo: REPO, rev: full, dir: join(work, `rev-${full.slice(0, 12)}`), log: (m) => console.log(m) });
	r.build = { stamp: b.stamp, buildMs: Math.round(b.buildMs), root: b.src, lockSha256: b.lockSha256, mode: 'isolated copy (git archive + reflinked node_modules after bun.lock identity check, bun run --bun build)' };
	const port = portBase, origPort = portBase + 1;
	const dataDir = join(work, `data-${full.slice(0, 12)}`);
	const logFile = join(out, `server-${full.slice(0, 12)}.log`);
	const start = () => startServer({ root: b.src, port, origPort, dataDir, buildDir: b.buildDir, logFile });
	const c = client(port);
	const origin = `http://127.0.0.1:${port}`;

	let srv = await start();
	r.firstStartMs = +srv.readyMs.toFixed(1);
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status} ${imp.text.slice(0, 500)}`);
	const act = await c.activate(imp.importId, { ack: true });
	const active = await c.activeVersion();
	if (active !== RV) throw new Error(`activation did not make v5 active: ${JSON.stringify(act)} active=${active}`);
	r.importActivate = { importId: imp.importId, importMs: Math.round(imp.ms), activateMs: Math.round(act.ms), active };

	// process start: stop, spawn, /api/health from the new PID; the active version is verified at startup
	const ps = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		await srv.stop('SIGTERM');
		srv = await start();
		ps.push({ i, warmup: i < WARMUP, ms: +srv.readyMs.toFixed(1), pid: srv.pid });
	}
	const health = await c.health();
	r.server = { pid: srv.pid, build: health.instance.build ?? null, bun: health.instance.bun, startupChecked: health.startup?.checked?.[RV] ?? null, recovery: health.recovery, storageError: health.storageError };

	// the cache policy as served
	const hdr = async (u, opts) => { const x = await fetch(u, { redirect: 'manual', ...opts }); await x.arrayBuffer(); return { status: x.status, cacheControl: x.headers.get('cache-control'), etag: !!x.headers.get('etag') }; };
	const docHtml = (ref) => c.get(`${vpath(RV)}/doc/${encodeURIComponent(ref)}`).then((x) => x.text);
	const ovHtml = (await c.get(`${vpath(RV)}/overview`)).text;
	const appAsset = /"((?:\.\.\/|\.\/|\/)*_app\/immutable\/[^"]+\.js)"/.exec(ovHtml)?.[1];
	const viewerHref = attrById(await docHtml(pdfSet.main[0].ref), 'open-original', 'href');
	const orig = health.instance.originalsOrigin;
	const viaOrig = (href) => { const u = new URL(href); return fetch(`http://127.0.0.1:${u.port}${u.pathname}${u.search}`, { headers: { host: u.host } }); };
	const vr = await viaOrig(viewerHref); const vText = await vr.text();
	r.cachePolicy = {
		browser: 'coldOverview: a fresh browser context per sample (empty HTTP cache, no cookies or storage), same Chromium process; warmNavigation: one warm tab and context (app assets cached as the server allows; the chronology list revalidated with its ETag); pdfFirstPage: a new tab per sample in one warm context; downloadStart: one warm tab, the download cancelled once it began',
		server: 'one server process per revision, restarted for the process-start samples, then warm; the OS page cache holds the fixture (no eviction)',
		served: {
			overview: await hdr(`${origin}${vpath(RV)}/overview`),
			chronologyApi: await hdr(`${origin}/api/v/${encodeURIComponent(RV)}/chronology`),
			appImmutableAsset: appAsset ? await hdr(new URL(appAsset, `${origin}${vpath(RV)}/overview`).href) : null,
			viewerWrapper: { status: vr.status, cacheControl: vr.headers.get('cache-control') },
			pdfjsFrameAsset: await (async () => { const f = /data-frame="([^"]+)"/.exec(vText)?.[1]; if (!f) return null; const x = await viaOrig(new URL(f.replace(/&amp;/g, '&'), orig).href); await x.arrayBuffer(); return { status: x.status, cacheControl: x.headers.get('cache-control') }; })(),
		},
	};

	const br = await guard(`${label}: browser launch`, deadline(2 * 60_000), () => launch({ profileRoot: join(work, 'profiles') }));
	r.browser = br.launch;
	try {
		const INIT = `(() => {
			const cc = window.__cc = { marks: {}, armed: { overview: true }, pending: {}, t0: null };
			const conds = {
				overview: () => !!document.querySelector('main[data-ready="overview"]') && (() => { const e = document.getElementById('count-documents'); return !!e && e.dataset.count === ${JSON.stringify(String(N))} && e.textContent.trim() === ${JSON.stringify(NTEXT)}; })(),
				chronology: () => !!document.querySelector('main[data-ready="chronology"]') && (() => { const e = document.getElementById('row-count'); return !!e && e.dataset.count === ${JSON.stringify(String(N))} && e.textContent.trim().startsWith(${JSON.stringify(`${NTEXT} of ${NTEXT}`)}); })(),
			};
			const check = () => { for (const k in conds) if (cc.armed[k] && !cc.pending[k] && conds[k]()) { cc.pending[k] = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.marks[k] = { at: performance.now(), seen, frame }; }; ch.port2.postMessage(0); }); } };
			cc.arm = (k) => { delete cc.marks[k]; delete cc.pending[k]; cc.armed[k] = true; cc.t0 = null; check(); };
			cc.disarm = (k) => { cc.armed[k] = false; };
			new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
			document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#nav-chronology')) cc.t0 = e.timeStamp; }, true);
		})()`;
		const nav = (p) => p.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { responseStart: +n.responseStart.toFixed(1), domContentLoaded: +n.domContentLoadedEventEnd.toFixed(1), load: +n.loadEventEnd.toFixed(1), transferSize: n.transferSize } : null; })()`);
		const box = (p, sel) => p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		const click = async (p, xy) => { await p.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };

		// cold usable overview
		console.log(`${label}: cold overview ...`);
		const cold = [];
		await guard(`${label}: cold overview`, PHASE_MS, async () => { for (let i = 0; i < WARMUP + SAMPLES; i++) {
			const p = await newPage(br, { fresh: true, initScript: INIT });
			try {
				await p.navigate(`${origin}${vpath(RV)}/overview`, { waitLoad: false });
				const m = await p.waitFor('window.__cc && window.__cc.marks.overview', 30000);
				cold.push({ i, warmup: i < WARMUP, ms: +m.at.toFixed(1), conditionSeenMs: +m.seen.toFixed(1), frameMs: +m.frame.toFixed(1), navigation: await nav(p) });
			} finally { await p.close(); }
		} });

		// warm client-side navigation overview -> chronology
		console.log(`${label}: warm navigation ...`);
		const warm = [];
		let P;
		const fullLoads = await guard(`${label}: warm navigation`, PHASE_MS, async () => {
			P = await newPage(br, { initScript: INIT });
			await P.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
			await P.navigate(`${origin}${vpath(RV)}/overview`);
			await P.waitFor('window.__cc && window.__cc.marks.overview', 30000);
			for (let i = 0; i < WARMUP + SAMPLES; i++) {
				const xy = await box(P, '#nav-chronology');
				if (!xy) throw new Error('no #nav-chronology link on the overview');
				await P.evaluate(`window.__cc.arm('chronology')`);
				await click(P, xy);
				const m = await P.waitFor(`window.__cc.marks.chronology && window.__cc.t0 !== null && { at: window.__cc.marks.chronology.at, seen: window.__cc.marks.chronology.seen, frame: window.__cc.marks.chronology.frame, t0: window.__cc.t0, path: location.pathname, api: (() => { const e = performance.getEntriesByType('resource').filter((x) => x.name.includes('/api/v/') && x.name.endsWith('/chronology')).at(-1); return e ? { start: e.startTime, end: e.responseEnd, transfer: e.transferSize, status: e.responseStatus } : null; })() }`, 30000);
				if (!m.path.endsWith('/chronology')) throw new Error(`warm navigation ended at ${m.path}`);
				warm.push({ i, warmup: i < WARMUP, ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), frameMs: +(m.frame - m.t0).toFixed(1), chronologyApi: m.api && m.api.start >= m.t0 ? { startMs: +(m.api.start - m.t0).toFixed(1), endMs: +(m.api.end - m.t0).toFixed(1), transferSize: m.api.transfer, status: m.api.status } : null });
				await P.evaluate(`window.__cc.disarm('chronology')`);
				const back = await box(P, '#nav-overview');
				if (!back) throw new Error('no #nav-overview link on the chronology');
				await P.evaluate(`window.__cc.arm('overview')`);
				await click(P, back);
				await P.waitFor(`window.__cc.marks.overview && location.pathname.endsWith('/overview')`, 30000);
			}
			return P.evaluate(`performance.getEntriesByType('navigation').length`);
		});

		// cited PDF: first rendered page in the viewer wrapper
		console.log(`${label}: PDF first page ...`);
		const pdf = [];
		const pdfOrder = [...pdfSet.warm.map((x) => ({ x, warmup: true })), ...pdfSet.main.map((x) => ({ x, warmup: false }))];
		const openPdf = async (x) => {
			const href = attrById(await docHtml(x.ref), 'open-original', 'href');
			if (!href || !href.startsWith(`${orig}/view/`)) throw new Error(`${x.ref}: no viewer link on the document page`);
			const t = await newPage(br);
			try {
				await t.navigate(href, { waitLoad: false });
				const st = await t.waitFor(`document.body && (document.body.dataset.ready === '1' || document.body.dataset.ready === 'error') ? { ready: document.body.dataset.ready, readyMs: Number(document.body.dataset.readyMs) } : null`, 120000);
				if (st.ready !== '1') throw new Error(`${x.ref}: the viewer reported ${st.ready}`);
				return st.readyMs;
			} finally { await t.close(); }
		};
		await guard(`${label}: PDF first page`, PHASE_MS, async () => { for (const [i, { x, warmup }] of pdfOrder.entries()) pdf.push({ i, warmup, ref: x.ref, size: x.size, ms: await openPdf(x) }); });
		// supplementary, not gated: the largest PDFs of the register, to show how first-page time scales with size
		const largest = [...files.filter((x) => x.mediaType === 'application/pdf')].sort((p, q) => q.size - p.size).slice(0, LARGEST);
		const pdfLarge = [];
		await guard(`${label}: PDF first page (largest)`, PHASE_MS, async () => { for (const [i, x] of largest.entries()) pdfLarge.push({ i, ref: x.ref, size: x.size, ms: await openPdf(x) }); });

		// download start
		console.log(`${label}: download start ...`);
		const dl = [];
		const dlOrder = [...dlSet.warm.map((x) => ({ x, warmup: true })), ...dlSet.main.map((x) => ({ x, warmup: false }))];
		await guard(`${label}: download start`, PHASE_MS, async () => { for (const [i, { x, warmup }] of dlOrder.entries()) {
			await P.navigate(`${origin}${vpath(RV)}/doc/${encodeURIComponent(x.ref)}`);
			await P.waitFor(`document.querySelector('main[data-ready=${JSON.stringify(`doc:${x.ref}`)}]') !== null`, 30000);
			const xy = await box(P, '#download-original');
			if (!xy) throw new Error(`${x.ref}: no #download-original`);
			if (await P.evaluate(`!!document.getElementById('open-original')`)) throw new Error(`${x.ref}: offers Open, not download-only`);
			const ev = nextDownload(br, (u) => u.includes(`/${encodeURIComponent(x.ref)}/`) || u.includes(`/${x.ref}/`), 60000);
			const t0 = performance.now();
			await click(P, xy);
			const d = await ev;
			await br.send('Browser.cancelDownload', { guid: d.guid }).catch(() => {});
			dl.push({ i, warmup, ref: x.ref, size: x.size, mediaType: x.mediaType, ms: +(d.at - t0).toFixed(1) });
		} });
		r.raw = { coldOverview: cold, warmNavigation: warm, pdfFirstPage: pdf, downloadStart: dl, processStart: ps };
		r.supplement = { pdfLargest: { gated: false, note: `the ${LARGEST} largest PDF originals, one sample each after the gated series (same method)`, samples: pdfLarge, over500Ms: pdfLarge.filter((x) => x.ms > BUDGETS.pdfFirstPage).length } };
		r.notes = { warmNavigationFullDocumentLoads: fullLoads };
	} finally {
		await br.close().catch(() => {});
		await srv.stop().catch(() => {});
	}
	const kept = (xs) => xs.filter((x) => !x.warmup).map((x) => x.ms);
	r.metrics = {};
	for (const k of ['coldOverview', 'warmNavigation', 'pdfFirstPage', 'downloadStart', 'processStart']) {
		const s = stats(kept(r.raw[k]));
		const budget = BUDGETS[k] ?? null;
		r.metrics[k] = { ...s, discardedWarmup: r.raw[k].filter((x) => x.warmup).length, budgetP95Ms: budget, gated: budget !== null, enoughSamples: s.n >= MIN_SAMPLES, pass: budget === null ? null : s.n >= MIN_SAMPLES && s.p95Ms <= budget };
	}
	const sizes = (xs) => ({ n: xs.length, minBytes: Math.min(...xs.map((x) => x.size)), maxBytes: Math.max(...xs.map((x) => x.size)) });
	r.metrics.pdfFirstPage.originals = sizes(pdfSet.main);
	r.metrics.downloadStart.originals = { ...sizes(dlSet.main), mediaTypes: Object.fromEntries(Object.entries(dlSet.main.reduce((m, x) => ((m[x.mediaType] = (m[x.mediaType] ?? 0) + 1), m), {}))) };
	r.status = Object.values(r.metrics).every((m) => m.pass !== false && m.enoughSamples) ? 'PASS' : 'FAIL';
	return r;
}

const canary = await startCanary();
const result = {
	ticket: 'CC-03', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`,
	worktree: git, host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	fixture: { sha256: fx.sha256, docCount: N, package: { dir: pkgRun.dir, reused: pkgRun.reused, resultsVersion: pkg.manifest.resultsVersion, convertMs: Math.round(pkgRun.ms) } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetsP95Ms: BUDGETS, nextFrame: 'a MutationObserver (installed before page scripts) sees the condition; the mark is taken in a task posted (MessageChannel) from the next requestAnimationFrame callback, i.e. after that frame was rendered', clocks: 'coldOverview and pdfFirstPage: the page\'s performance.now() (ms since its navigation start); warmNavigation: click event timeStamp to the mark, same page clock; downloadStart and processStart: the runner\'s performance.now()' },
	sampleSets: { pdf: { warmup: pdfSet.warm.map((x) => ({ ref: x.ref, size: x.size })), kept: pdfSet.main.map((x) => ({ ref: x.ref, size: x.size })) }, download: { warmup: dlSet.warm.map((x) => ({ ref: x.ref, size: x.size, mediaType: x.mediaType })), kept: dlSet.main.map((x) => ({ ref: x.ref, size: x.size, mediaType: x.mediaType })) } },
	revisions: {},
};
let failure = null, aborted = null;
try {
	result.revisions.baseline = await measureRevision('baseline', rev(a.baseline), PORTS.first + 20);
	result.revisions.candidate = await measureRevision('candidate', rev(a.candidate), PORTS.first + 30);
} catch (e) {
	aborted = abortOf(e, 'the measurement')?.record ?? null;
	if (aborted) exitWithin(30_000, 1, 'cc03');
	failure = aborted ? abortReason(aborted) : String(e?.stack ?? e);
	console.error(`cc03: ${failure}`);
}
await canary.close().catch(() => {});
result.canaryHits = canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null }));
result.finishedAt = new Date().toISOString();
const cand = result.revisions.candidate;
result.error = failure;
if (aborted) Object.assign(result, { aborted, evidence: false, evidenceNote: `NOT release evidence: ${abortReason(aborted)}` });
result.ok = !failure && cand?.status === 'PASS';
writeFileSync(join(out, 'measure-CC-03.json'), JSON.stringify(result, null, 1));
if (cand?.metrics) {
	console.log(`\nCC-03 candidate ${cand.revision.slice(0, 12)} (build ${cand.build.stamp.buildId}); baseline ${result.revisions.baseline?.status ?? '?'}`);
	for (const [k, m] of Object.entries(cand.metrics)) console.log(`${k.padEnd(15)} n=${m.n} p50 ${m.p50Ms} p95 ${m.p95Ms} max ${m.maxMs} ms${m.gated ? ` (budget p95 <= ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})` : ' (not gated)'}`);
	const sup = cand.supplement?.pdfLargest;
	if (sup) console.log(`pdfLargest      (not gated) ${sup.samples.map((x) => `${(x.size / 2 ** 20).toFixed(1)} MiB ${x.ms} ms`).join('; ')}`);
}
if (!a.keep) rmSync(work, { recursive: true, force: true });
console.log(`measure CC-03: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-03.json')}`);
process.exit(result.ok ? 0 : 1);
