#!/usr/bin/env bun
// The M2 readiness metrics (GRS-21, CC-11), offline, on this host, against the production build (./build) under Bun:
//
//   bun scripts/verify/metrics.mjs [--samples 20] [--warmup 2] [--out DIR] [--skip-reused]
//
// Budgets from the issue: cold overview p95 <= 2,000 ms; warm navigation and state write p95 <= 200 ms; search p95 <= 300
// ms; at least 20 kept samples per metric after warm-up; no ratio across unlike scenarios.
//
// Measured here, interleaved sample by sample with the v5 reference (the main HTML of the real v5 sample opened read-only
// as a file: URL, as the parity harness opens it; scripts/parity/lib/browser.mjs v5Page), because the scenarios are
// comparable (one person opens the case, then moves from the overview to the chronology):
//   coldOverview    a fresh browser context per sample: navigation start -> the overview rendered (app:
//                   main[data-ready=overview] with #count-documents; v5: its boot render of #main with go() defined),
//                   then the next rendered frame;
//   warmNavigation  one warm tab per side: a real mouse click on the Chronology navigation entry (the click's timeStamp)
//                   -> the chronology rendered (app: main[data-ready=chronology] with #row-count; v5: #main re-rendered
//                   with its table), then the next rendered frame; back to the overview between samples, unmeasured.
// The app side imports and activates the real v5 package in a temporary data directory. Reference and head are reported
// side by side with their own p95; the head's p95 is compared with the budget. No ratio is taken: the reference is one
// static HTML document with every dataset embedded, the app a server-rendered SvelteKit app over SQLite.
// Reused, not re-implemented (head only; the reference has no comparable scenario): search p95 from
// `measure --ticket CC-04` (GRS-14) and state write (register save) p95 from `measure --ticket CC-07` (GRS-17), run as
// child processes with the same --samples and --warmup; --skip-reused leaves them out.
// "Next rendered frame": the condition is watched by a MutationObserver installed before any page script; the next
// requestAnimationFrame callback posts a MessageChannel task, which takes the mark (as scripts/measure/cc03.mjs).
// Percentiles are nearest-rank. Results: DIR/metrics.json (default .local/GRS-21/metrics; timings and counts only).
// Exit 0 when every budget holds with enough samples, 1 if not, 2 on a setup error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureOffline, PORTS, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SAMPLES = +arg('--samples', 20), WARMUP = +arg('--warmup', 2);
const OUT = resolve(arg('--out', join(ROOT, '.local', 'GRS-21', 'metrics')));
const BUDGETS = { coldOverview: 2000, warmNavigation: 200, search: 300, stateWrite: 200 };
const J = JSON.stringify;

// the reused measurements run outside the namespace (each re-execs itself offline); this file's own part runs inside
if (process.env.CLEARCASE_OFFLINE !== '1' && !process.argv.includes('--skip-reused')) {
	mkdirSync(OUT, { recursive: true });
	const reused = {};
	for (const [ticket, key] of [['CC-04', 'search'], ['CC-07', 'save']]) {
		const out = join(OUT, ticket);
		const r = spawnSync(process.execPath, ['run', '--bun', 'measure', '--ticket', ticket, '--samples', String(SAMPLES), '--warmup', String(WARMUP), '--out', out], { cwd: ROOT, encoding: 'utf8' });
		writeFileSync(join(OUT, `${ticket}.log`), r.stdout + r.stderr);
		reused[ticket] = { exit: r.status, file: join(out, `measure-${ticket}.json`), key };
		console.log(`measure ${ticket}: exit ${r.status}`);
	}
	writeFileSync(join(OUT, 'reused.json'), J(reused, null, 1));
}
ensureOffline(import.meta.filename);
const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { launch, newPage, sleep } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { appServer, vpath } = await import('../../tests/e2e/pilot/suite/context.mjs');
const { loadConfig, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
const { clockScript } = await import('../parity/lib/browser.mjs');

mkdirSync(OUT, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
/** Installed before any page script: arm(cond) watches `cond` after the next click (or from navigation start when cold). */
const TIMER = `(() => { const cc = window.__cc = { t0: null, mark: null, want: false };
	document.addEventListener('click', (e) => { if (cc.want && cc.t0 === null) cc.t0 = e.timeStamp; }, true);
	cc.arm = (cond, cold) => { cc.mark = null; cc.want = !cold; cc.t0 = cold ? 0 : null; const f = new Function('return (' + cond + ')');
		const check = () => { if (cc.mark || cc.t0 === null) return; let ok = false; try { ok = !!f(); } catch {} if (!ok) return; const seen = performance.now(); obs.disconnect(); clearInterval(iv);
			requestAnimationFrame((frame) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.mark = { at: performance.now(), seen, frame }; }; ch.port2.postMessage(0); }); };
		const obs = new MutationObserver(check); obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); const iv = setInterval(check, 5); check(); return true; };
})()`;
const COND = {
	app: { overview: `document.querySelector('main#main')?.dataset.ready === 'overview' && !!document.getElementById('count-documents')`, chronology: `document.querySelector('main#main')?.dataset.ready === 'chronology' && !!document.getElementById('row-count')` },
	v5: { overview: `typeof go === 'function' && typeof RENDER === 'object' && !!document.querySelector('#main h1, #main .kpi, #main .card')`, chronology: `!document.getElementById('__cc_old') && !!document.querySelector('#main table tbody tr')` },
};
const NAV = { app: '#nav-chronology', v5: 'a[data-tab="chronology"]' };

const offline = await proveOffline();
if (!offline.pass) { console.error('metrics: not offline'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'cc-verify-metrics-'));
const A = appServer({ name: 'metrics', root: ROOT, buildDir: join(ROOT, 'build'), port: PORTS.first + 60, origPort: PORTS.first + 61, dir: tmp, env: { TZ: 'UTC' } });
const out = { budgets: BUDGETS, samples: SAMPLES, warmup: WARMUP, percentile: 'nearest-rank', interleaved: ['coldOverview', 'warmNavigation'], raw: { app: { coldOverview: [], warmNavigation: [] }, v5: { coldOverview: [], warmNavigation: [] } }, metrics: {} };
let b, code = 2;
try {
	const fx = await loadConfig();
	const pkg = v5Package(fx, join(tmp, 'v5-package'));
	await A.start();
	const imp = await A.c.importPkg(fx.caseFolder, pkg.dir);
	await A.c.activate(imp.importId);
	const rv = await A.c.activeVersion();
	if (rv !== fx.accepted.resultsVersion) throw new Error(`the v5 package did not activate (active ${rv})`);
	const URLS = { app: `${A.v(rv)}/overview`, v5: pathToFileURL(fx.cfg.mainHtml.path).href };
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const page = async (side, fresh) => { const p = await newPage(b, { fresh, initScript: `${side === 'v5' ? clockScript(CLOCK) + ';' : ''}${TIMER}` }); await p.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); return p; };
	const cold = async (side) => {
		const p = await page(side, true);
		try {
			// the timer is armed at document start for this navigation (cold: from navigation start, performance.now() = 0)
			await p.s('Page.addScriptToEvaluateOnNewDocument', { source: `window.__cc.arm(${J(COND[side].overview)}, true)` });
			await p.navigate(URLS[side], { timeout: 60000 });
			const m = await p.waitFor(`window.__cc?.mark`, 60000);
			return +m.at.toFixed(1);
		} finally { await p.close(); }
	};
	const warmTabs = {};
	const warm = async (side) => {
		let p = warmTabs[side];
		if (!p) { p = warmTabs[side] = await page(side, false); await p.navigate(URLS[side], { timeout: 60000 }); await p.waitFor(COND[side].overview, 60000); }
		// a background tab gets no animation frames: the measured tab is brought to the front each time
		await p.s('Page.bringToFront');
		// back to the overview, unmeasured: the app by its navigation entry, v5 by go()
		if (side === 'app') { await p.evaluate(`document.getElementById('nav-overview').click(); true`); await p.waitFor(COND.app.overview, 30000); } else { await p.evaluate(`go('overview'); true`); await p.waitFor(COND.v5.overview, 30000); }
		if (side === 'v5') await p.evaluate(`(() => { const i = document.createElement('i'); i.id = '__cc_old'; document.getElementById('main').prepend(i); return true; })()`);
		await sleep(50);
		await p.evaluate(`window.__cc.arm(${J(COND[side].chronology)}, false)`);
		const xy = await p.evaluate(`(() => { const e = document.querySelector(${J(NAV[side])}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		await p.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y });
		for (const type of ['mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 });
		const m = await p.waitFor(`window.__cc.mark && window.__cc.t0 !== null && { at: window.__cc.mark.at, t0: window.__cc.t0 }`, 60000).catch(async (e) => {
			const why = await p.evaluate(`({ t0: window.__cc.t0, mark: window.__cc.mark, url: location.href.slice(-60), ready: document.querySelector('main#main')?.dataset.ready ?? null, rowCount: !!document.getElementById('row-count'), old: !!document.getElementById('__cc_old'), tables: document.querySelectorAll('#main table').length, rows: document.querySelectorAll('#main tbody tr').length, h: document.querySelector('#main h1, #main h2')?.textContent.slice(0, 40) ?? null })`).catch(() => null);
			throw new Error(`${side} warm navigation did not finish: ${J(why)} (${e.message.slice(0, 80)})`);
		});
		return +(m.at - m.t0).toFixed(1);
	};
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		// interleaved: reference then head on even samples, head then reference on odd ones
		for (const side of i % 2 ? ['app', 'v5'] : ['v5', 'app']) out.raw[side].coldOverview.push({ i, warmup: i < WARMUP, ms: await cold(side) });
		for (const side of i % 2 ? ['app', 'v5'] : ['v5', 'app']) out.raw[side].warmNavigation.push({ i, warmup: i < WARMUP, ms: await warm(side) });
		process.stdout.write(`sample ${i + 1}/${WARMUP + SAMPLES}\r`);
	}
	for (const side of ['app', 'v5']) for (const k of ['coldOverview', 'warmNavigation']) {
		const kept = out.raw[side][k].filter((x) => !x.warmup).map((x) => x.ms);
		out.metrics[`${side}.${k}`] = { side: side === 'app' ? 'head' : 'v5 reference', ...stats(kept), budgetP95Ms: side === 'app' ? BUDGETS[k] : null };
	}
	// the reused measurements, read back
	const reused = existsSync(join(OUT, 'reused.json')) ? JSON.parse(readFileSync(join(OUT, 'reused.json'), 'utf8')) : {};
	const pick = (ticket, name, key, budget) => {
		const r = reused[ticket];
		if (!r || !existsSync(r.file)) { out.metrics[name] = { side: 'head', missing: true, source: ticket, budgetP95Ms: budget }; return; }
		const d = JSON.parse(readFileSync(r.file, 'utf8'));
		const found = [];
		const walk = (o, path) => { if (!o || typeof o !== 'object') return; if (typeof o.p95Ms === 'number' && path.toLowerCase().includes(key)) found.push({ path, n: o.n, p50Ms: o.p50Ms, p95Ms: o.p95Ms, maxMs: o.maxMs }); for (const [k, v] of Object.entries(o)) if (k !== 'raw') walk(v, path ? `${path}.${k}` : k); };
		walk(d, '');
		const worst = found.sort((x, y) => y.p95Ms - x.p95Ms)[0] ?? null;
		out.metrics[name] = { side: 'head', source: `measure --ticket ${ticket} (exit ${r.exit})`, file: r.file.slice(ROOT.length + 1), series: found.length, worst, n: worst ? Math.min(...found.map((f) => f.n)) : 0, p95Ms: worst?.p95Ms ?? null, budgetP95Ms: budget };
	};
	pick('CC-04', 'app.search', 'search', BUDGETS.search);
	pick('CC-07', 'app.stateWrite', 'save', BUDGETS.stateWrite);
	const failures = [];
	for (const [k, m] of Object.entries(out.metrics)) {
		if (m.budgetP95Ms == null) continue;
		m.pass = !m.missing && m.n >= SAMPLES && m.p95Ms !== null && m.p95Ms <= m.budgetP95Ms;
		if (!m.pass) failures.push(k);
	}
	out.failures = failures;
	code = failures.length ? 1 : 0;
} catch (e) {
	console.error(`metrics: ${String(e?.stack ?? e).slice(0, 2000)}`);
	out.error = String(e?.message ?? e);
} finally {
	await b?.close().catch(() => {});
	await A.stop().catch(() => {});
	out.exit = code;
	writeFileSync(join(OUT, 'metrics.json'), J(out, null, 1));
	rmSync(tmp, { recursive: true, force: true });
}
for (const [k, m] of Object.entries(out.metrics)) console.log(`${k.padEnd(22)} n=${m.n ?? 0} p50 ${m.p50Ms ?? '-'} p95 ${m.p95Ms ?? '-'} ms${m.budgetP95Ms != null ? ` (budget ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})` : ' (reference, not gated)'}`);
console.log(`metrics: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code}) -> ${join(OUT, 'metrics.json')}`);
process.exit(code);
