#!/usr/bin/env bun
// CC-06 (GRS-16) performance measurement of the quantum views, offline, on this host, against the production build of
// the revision under test under Bun, with the REAL v5 sample imported and activated:
//
//   bun run --bun measure --ticket CC-06 [--candidate REV (default HEAD)] [--samples 20] [--warmup 2] [--out DIR]
//       [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// The candidate is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs), never ./build; there are no
// baseline builds. The server runs with the parity clock (CLEARCASE_FIXED_NOW 2026-10-08T09:00:00Z, TZ=UTC). Metrics,
// each >= --samples kept samples after --warmup discarded ones, nearest-rank percentiles (exit 1 if a budget fails or a
// metric has fewer than 20 samples, or if any numeric difference from v5 is unexplained; 2 on a usage error):
//   recalcInterest    Interest Recalculator, one warm tab: the capital is changed (alternating two values), then a click
//                     on Compute (event timeStamp) -> the output shows the expected capital, then the next frame.
//   recalcSettlement  Settlement / BATNA: the probability is changed (alternating), click on Model -> the base KPI shows
//                     the new probability, then the next frame.
//   ledgerNavigation  one warm tab: click on the Invoice Ledger link in the navigation -> client-side navigation until
//                     main[data-ready=invoice_ledger_tab] and every ledger row is rendered, then the next frame.
//   quantumNavigation the same to Quantum & Interest (its invoice ledger card has every row).
// Budgets: p95 <= 200 ms for each. Numeric check: every figure the views show on the sample (headline, gross,
// ledger sum, chart peak, counts, payments, the interest defaults and expected examples, the settlement defaults) is
// recomputed with v5's own formulas (parseFloat, toFixed(2)) from the package data and compared; a difference must be
// listed in EXPLAINED with its register reason, or it counts as unexplained. Raw timings and values go to
// <out>/measure-CC-06.json (default $CLEARCASE_REPORT_DIR/measure, else .local/measure): case material, local only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc06: ${m}\nusage: measure --ticket CC-06 [--candidate REV] [--samples 20] [--warmup 2] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-06') usage(`this runner measures CC-06, not ${a.ticket}`);
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || !Number.isInteger(WARMUP) || WARMUP < 0) usage('--samples and --warmup must be non-negative integers');
const MIN_SAMPLES = 20;
const BUDGETS = { recalcInterest: 200, recalcSettlement: 200, ledgerNavigation: 200, quantumNavigation: 200 };
const CLOCK = '2026-10-08T09:00:00Z';
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc06-work'));
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
if (!proof.pass) { console.error(`cc06: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc06: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const RV = fx.accepted.resultsVersion;

console.log('converting the v5 main HTML with GRS-10\'s converter ...');
const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
if (pkgRun.exit !== 0) { console.error(`cc06: conversion failed: ${pkgRun.stderr}`); process.exit(1); }
const pkg = readPackage(pkgRun.dir);
if (pkg.manifest.resultsVersion !== RV) { console.error(`cc06: package resultsVersion ${pkg.manifest.resultsVersion} differs from the accepted ${RV}`); process.exit(1); }
const Q = pkg.dataset('quantum').data;
const LIT = (k) => pkg.dataset(k).data;
const LEDGER = Q.invoiceLedger.length;

// ---- v5's own formulas (the reference): parseFloat, fmtR with toFixed(2) ------------------------------------------------
const v5fmtR = (n) => { if (!Number.isFinite(n)) return ''; const [i, d] = Math.abs(n).toFixed(2).split('.'); return `${n < 0 ? '-' : ''}R ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${d}`; };
const v5money = (v) => (v == null || v === '' ? '' : v5fmtR(parseFloat(String(v).replace(/[^\d.-]/g, ''))));
const pf = (s) => parseFloat(s) || 0;
/** Differences the register explains (none are expected on the sample's inputs). */
const EXPLAINED = {};

const candidate = a.candidate ?? 'HEAD';
const result = { ticket: 'CC-06', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`, worktree: gitIdentity(), host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	fixture: { sha256: fx.sha256, docCount: fx.summary.mainHtml.docCount, invoiceLedgerRows: LEDGER, package: { resultsVersion: RV, reused: pkgRun.reused } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetsP95Ms: BUDGETS, clock: CLOCK, nextFrame: 'a MutationObserver sees the condition; the mark is taken in a task posted from the next requestAnimationFrame callback (after that frame rendered)', clocks: 'click event timeStamp to the mark, the page clock' } };
const canary = await startCanary();
let failure = null, srv = null, br = null;
try {
	console.log(`candidate: isolated build of ${candidate} ...`);
	const b = isolatedBuild({ repo: REPO, rev: candidate, dir: join(work, 'candidate'), log: (m) => console.log(m) });
	result.build = { stamp: b.stamp, buildMs: Math.round(b.buildMs), mode: 'isolated copy (git archive + reflinked node_modules after bun.lock identity check, bun run --bun build)' };
	const port = PORTS.first + 60;
	srv = await startServer({ root: b.src, port, origPort: port + 1, dataDir: join(work, 'data'), buildDir: b.buildDir, logFile: join(out, 'server-cc06.log'), env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
	const c = client(port);
	const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
	if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status} ${imp.text.slice(0, 300)}`);
	await c.activate(imp.importId, { ack: true });
	if ((await c.activeVersion()) !== RV) throw new Error('activation did not make the v5 sample active');
	const base = `http://127.0.0.1:${port}${vpath(RV)}`;
	br = await launch({ profileRoot: join(work, 'profiles') });
	const INIT = `(() => {
		const cc = window.__cc = { marks: {}, armed: {}, pending: {}, t0: null, cond: {} };
		const check = () => { for (const k in cc.cond) if (cc.armed[k] && !cc.pending[k] && (() => { try { return cc.cond[k](); } catch { return false; } })()) { cc.pending[k] = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.marks[k] = { at: performance.now(), seen, frame }; }; ch.port2.postMessage(0); }); } };
		cc.arm = (k, src) => { cc.cond[k] = new Function('return (' + src + ')'); delete cc.marks[k]; delete cc.pending[k]; cc.armed[k] = true; cc.t0 = null; check(); };
		cc.disarm = (k) => { cc.armed[k] = false; };
		new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-cc-measure]')) cc.t0 = e.timeStamp; }, true);
	})()`;
	const P = await newPage(br, { initScript: INIT });
	await P.s('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
	const box = (sel) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.setAttribute('data-cc-measure', '1'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	const click = async (xy) => { await P.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await P.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };
	const set = (sel, v) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	/** One timed interaction: arm the condition, click, wait for the mark; ms from the click's timeStamp. */
	const timed = async (key, cond, sel) => {
		const xy = await box(sel);
		if (!xy) throw new Error(`no ${sel}`);
		await P.evaluate(`window.__cc.arm(${JSON.stringify(key)}, ${JSON.stringify(cond)})`);
		await click(xy);
		const m = await P.waitFor(`window.__cc.marks[${JSON.stringify(key)}] && window.__cc.t0 !== null && { at: window.__cc.marks[${JSON.stringify(key)}].at, seen: window.__cc.marks[${JSON.stringify(key)}].seen, t0: window.__cc.t0, path: location.pathname }`, 30000);
		await P.evaluate(`window.__cc.disarm(${JSON.stringify(key)})`);
		return { ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), path: m.path };
	};
	const series = async (n, fn) => { const xs = []; for (let i = 0; i < WARMUP + n; i++) xs.push({ i, warmup: i < WARMUP, ...(await fn(i)) }); return xs; };
	const raw = {};

	console.log('recalculation: interest ...');
	await P.navigate(`${base}/quantum/interest_calc_tab`);
	await P.waitFor(`!!document.querySelector('main[data-ready="interest_calc_tab"][data-hydrated]')`, 30000);
	await set('#ic_from', '2004-02-03'); await set('#ic_to', '2005-02-03'); await set('#ic_r', '10');
	raw.recalcInterest = await series(SAMPLES, async (i) => {
		const cap = i % 2 ? '100000' : '200000';
		await set('#ic_p', cap);
		return timed('ic', `[...document.querySelectorAll('#ic_out .kpi .v')][0]?.textContent.trim() === ${JSON.stringify(cap === '100000' ? 'R 100 000.00' : 'R 200 000.00')} && location.search.includes('p=${cap}')`, '#ic-compute');
	});

	console.log('recalculation: settlement ...');
	await P.navigate(`${base}/quantum/settlement_tab`);
	await P.waitFor(`!!document.querySelector('main[data-ready="settlement_tab"][data-hydrated]')`, 30000);
	raw.recalcSettlement = await series(SAMPLES, async (i) => {
		const p = String(40 + (i % 2) * 20 + (i % 5));
		await set('#se_p', p);
		return timed('se', `[...document.querySelectorAll('#se_out .kpi .k')].some((e) => e.textContent.trim() === 'Base (p=${p}%)') && location.search.includes('p=${p}')`, '#se-model');
	});

	console.log('warm navigation: invoice ledger and quantum ...');
	await P.navigate(`${base}/overview`);
	await P.waitFor(`!!document.querySelector('main[data-ready="overview"]')`, 30000);
	const toView = async (view, rowsSel) => timed(`nav-${view}`, `!!document.querySelector('main[data-ready="${view}"]') && document.querySelectorAll(${JSON.stringify(rowsSel)}).length === ${LEDGER}`, `#nav-${view}`);
	const back = async () => { await click(await box('#nav-overview')); await P.waitFor(`!!document.querySelector('main[data-ready="overview"]') && location.pathname.endsWith('/overview')`, 30000); };
	raw.ledgerNavigation = await series(SAMPLES, async () => { const r = await toView('invoice_ledger_tab', '#invoice-ledger tbody tr'); await back(); return r; });
	raw.quantumNavigation = await series(SAMPLES, async () => { const r = await toView('quantum_tab', '#invoice-ledger tbody tr'); await back(); return r; });
	result.notes = { fullDocumentLoads: await P.evaluate(`performance.getEntriesByType('navigation').length`) };

	// ---- numeric check: the app's figures against v5's formulas on the same data -----------------------------------------
	console.log('numeric check against v5\'s formulas ...');
	const kpis = (root = '#main') => P.evaluate(`Object.fromEntries([...document.querySelectorAll(${JSON.stringify(`${root} .kpi`)})].map((k) => [k.querySelector('.k').textContent.trim(), k.querySelector('.v').textContent.replace(/\\s+/g, ' ').trim()]))`);
	const go = async (path, view) => { await P.navigate(`${base}${path}`); await P.waitFor(`!!document.querySelector('main[data-ready="${view}"][data-hydrated]')`, 30000); };
	const checks = [];
	const cmp = (view, what, app, v5) => checks.push({ view, what, app, v5, same: app === v5 });
	await go('/quantum/quantum_tab', 'quantum_tab');
	let k = await kpis();
	const vals = Q.amountDueSeries.map((s) => pf(s.amount));
	cmp('quantum_tab', 'Amount due (to date)', k['Amount due (to date)'], v5money(Q.headline_due));
	cmp('quantum_tab', 'Gross invoiced (unreconciled)', k['Gross invoiced (unreconciled)'], v5money(Q.grossInvoiced));
	cmp('quantum_tab', 'Invoices in ledger', k['Invoices in ledger'], Q.invoiceCount.toLocaleString('en'));
	cmp('quantum_tab', 'Charging calcs', k['Charging calcs'], String(Q.chargingCount));
	cmp('quantum_tab', 'Statements', k['Statements'], String(Q.statementSeries.length));
	cmp('quantum_tab', 'Interest computations', k['Interest computations'], String(Q.interestSeries.length));
	cmp('quantum_tab', 'chart peak', await P.evaluate(`document.querySelector('#main p.tag')?.textContent.trim().split(' · peak ')[1] ?? null`), v5money(Math.max(...vals)));
	const amounts = await P.evaluate(`[...document.querySelectorAll('#amount-due-series tbody tr')].map((r) => r.cells[2].textContent.trim())`);
	cmp('quantum_tab', 'series amounts', JSON.stringify(amounts), JSON.stringify(Q.amountDueSeries.slice().reverse().map((s) => v5money(s.amount))));
	const ledgerAmounts = await P.evaluate(`[...document.querySelectorAll('#invoice-ledger tbody tr')].map((r) => r.cells[3].textContent.trim())`);
	cmp('quantum_tab', 'ledger amounts', JSON.stringify(ledgerAmounts), JSON.stringify(Q.invoiceLedger.map((r) => v5money(r.amount))));
	await go('/quantum/invoice_ledger_tab', 'invoice_ledger_tab');
	k = await kpis();
	cmp('invoice_ledger_tab', 'Gross invoiced (sum, unreconciled)', k['Gross invoiced (sum, unreconciled)'], v5money(Q.invoiceLedger.reduce((s, r) => s + pf(r.amount), 0)));
	await go('/quantum/payments_tab', 'payments_tab');
	k = await kpis();
	const S = LIT('lit-settlement');
	cmp('payments_tab', 'Gross amount due', k['Gross amount due'], v5fmtR(pf(S.claim)));
	cmp('payments_tab', 'Payments recorded', k['Payments recorded'], v5fmtR(0));
	cmp('payments_tab', 'Net claim', k['Net claim'], v5fmtR(pf(S.claim) - 0));
	await go('/quantum/prescription_tab', 'prescription_tab');
	k = await kpis();
	const PS = LIT('lit-presc-summary');
	cmp('prescription_tab', 'Invoices tracked', k['Invoices tracked'], String(PS.total));
	cmp('prescription_tab', 'Rely on interruption', k['Rely on interruption'], String(PS.reliesOnInterruption));
	// interest: v5's calcInterest on the defaults (empty capital) and on the expected examples
	const B = LIT('lit-interest-basis');
	const v5interest = (P0, r, m, from, to) => { const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000; const years = days / 365.25; let interest, total; if (m.includes('Compound')) { total = P0 * Math.pow(1 + r / 100 / 12, years * 12); interest = total - P0; } else { interest = P0 * (r / 100) * years; total = P0 + interest; } const head = pf(B.headline_due); return { Capital: v5fmtR(P0), [`Interest (${years > 0 ? years.toFixed(2) : '0'} yrs)`]: v5fmtR(interest), Total: v5fmtR(total), 'vs extracted Amount Due': v5fmtR(head) }; };
	await go('/quantum/interest_calc_tab', 'interest_calc_tab');
	const rate = await P.evaluate(`document.getElementById('ic_r').value`);
	for (const [name, q] of [['defaults', { p: '', r: rate, m: 'Simple', from: B.first_invoice_date || B.award_date, to: B.headline_date }], ['interest-simple', { p: '100000', r: '10', m: 'Simple', from: '2004-02-03', to: '2005-02-03' }], ['interest-compound', { p: '100000', r: '10', m: 'Compound (monthly)', from: '2004-02-03', to: '2005-02-03' }]]) {
		await go(`/quantum/interest_calc_tab?${new URLSearchParams(q)}`, 'interest_calc_tab');
		cmp('interest_calc_tab', name, JSON.stringify(await kpis('#ic_out')), JSON.stringify(v5interest(pf(q.p), pf(q.r), q.m, q.from, q.to)));
	}
	// settlement: v5's calcSettle on the page's own defaults
	await go('/quantum/settlement_tab', 'settlement_tab');
	const inp = await P.evaluate(`['se_claim', 'se_p', 'se_y', 'se_d', 'se_c'].map((id) => document.getElementById(id).value)`);
	const [claim, p, y, d, cost] = inp.map(pf);
	const ev = (prob) => claim * prob / 100 / Math.pow(1 + d / 100, y) - cost;
	cmp('settlement_tab', 'claim prefill', inp[0], (pf(S.claim) || 0).toFixed(0));
	cmp('settlement_tab', 'scenarios', JSON.stringify(await kpis('#se_out')), JSON.stringify({ 'Pessimistic (p-25)': v5fmtR(ev(Math.max(0, p - 25))), [`Base (p=${p}%)`]: v5fmtR(ev(p)), 'Optimistic (p+15)': v5fmtR(ev(Math.min(100, p + 15))) }));
	const diffs = checks.filter((x) => !x.same).map((x) => ({ ...x, explainedBy: EXPLAINED[`${x.view}:${x.what}`] ?? null }));
	result.numeric = { checks: checks.length, differences: diffs.length, unexplained: diffs.filter((x) => !x.explainedBy).length, detail: checks };

	const kept = (xs) => xs.filter((x) => !x.warmup).map((x) => x.ms);
	result.raw = raw;
	result.metrics = {};
	for (const key of Object.keys(BUDGETS)) {
		const s = stats(kept(raw[key]));
		result.metrics[key] = { ...s, discardedWarmup: raw[key].filter((x) => x.warmup).length, budgetP95Ms: BUDGETS[key], enoughSamples: s.n >= MIN_SAMPLES, pass: s.n >= MIN_SAMPLES && s.p95Ms <= BUDGETS[key] };
	}
} catch (e) { failure = String(e?.stack ?? e); console.error(`cc06: ${failure}`); }
await br?.close().catch(() => {});
await srv?.stop().catch(() => {});
await canary.close().catch(() => {});
// Chromium's own background services (component updates, safe browsing) are counted apart, as the pilot suite does
// (tests/e2e/pilot/suite/context.mjs isBackground); any other canary hit fails the run.
const BACKGROUND_HOST = /(^|\.)(google\.com|gvt1\.com|googleapis\.com|gstatic\.com)$/i;
const isBackground = (h) => BACKGROUND_HOST.test(h.host?.replace(/:\d+$/, '') ?? h.sni ?? '') && !h.origin && !h.referer;
result.canaryHits = canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null, browserBackground: isBackground(h) }));
result.finishedAt = new Date().toISOString();
result.error = failure;
result.ok = !failure && Object.values(result.metrics ?? {}).length === 4 && Object.values(result.metrics).every((m) => m.pass) && result.numeric?.unexplained === 0 && result.canaryHits.every((h) => h.browserBackground);
writeFileSync(join(out, 'measure-CC-06.json'), JSON.stringify(result, null, 1));
if (result.metrics) {
	console.log(`\nCC-06 candidate ${result.build?.stamp?.revision?.slice(0, 12) ?? '?'} (build ${result.build?.stamp?.buildId ?? '?'}); fixture ${result.fixture.docCount} documents, ${LEDGER} ledger rows`);
	for (const [key, m] of Object.entries(result.metrics)) console.log(`${key.padEnd(18)} n=${m.n} p50 ${m.p50Ms} p95 ${m.p95Ms} max ${m.maxMs} ms (budget p95 <= ${m.budgetP95Ms}: ${m.pass ? 'PASS' : 'FAIL'})`);
}
if (result.numeric) console.log(`numeric check: ${result.numeric.checks} figures against v5's formulas, ${result.numeric.differences} differences, ${result.numeric.unexplained} unexplained`);
if (!a.keep) rmSync(work, { recursive: true, force: true });
console.log(`measure CC-06: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-06.json')}`);
process.exit(result.ok ? 0 : 1);
