#!/usr/bin/env bun
// CC-08 (GRS-18) performance measurement of the litigation views: preparation navigation and save latency, offline,
// on this host, against a production build under Bun:
//
//   bun run --bun measure --ticket CC-08 [--candidate REV (default HEAD)] [--samples 20] [--warmup 2] [--rows 500]
//       [--out DIR] [--config .local/v5-verification.json] [--work DIR] [--keep]
//
// The revision under test is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs: git archive +
// reflinked node_modules after a bun.lock identity check, `bun run --bun build`), never ./build, and runs alone (no
// baseline build). Metrics, each >= --samples kept samples after --warmup discarded ones, nearest-rank p95; exit 1 if
// a budget fails or a metric has fewer samples, 2 on a usage or prerequisite error:
//   warmNavigation  the REAL v5 sample imported and activated; one warm tab; a mouse click on the next litigation
//                   view's navigation link (event timeStamp) -> client-side navigation until main[data-ready=<view>]
//                   on its route, then the next rendered frame. The seven views in turn. Budget p95 <= 200 ms.
//   save<View>      a synthetic case (GRS-10's converter) with --rows saved rows in the register (entered through the
//                   view's own form action beforehand); one warm tab on the view; a mouse click on Add (event
//                   timeStamp) -> the new row rendered (row count + 1, no error shown), then the next frame. Heads of
//                   Argument, Authorities and Cross-Exam Prep. Budget p95 <= 200 ms each.
// "Next rendered frame" is measured as cc03.mjs does: a MutationObserver installed before page scripts sees the
// condition; the mark is taken in a task posted from the next requestAnimationFrame callback. Raw samples and
// identities go to <out>/measure-CC-08.json (default $CLEARCASE_REPORT_DIR/measure, else .local/measure); the real
// sample's identity there is case material and stays local. This file holds no case values.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' }, rows: { type: 'string' },
	out: { type: 'string' }, config: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc08: ${m}\nusage: measure --ticket CC-08 [--candidate REV] [--samples 20] [--warmup 2] [--rows 500] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-08') usage(`this runner measures CC-08, not ${a.ticket}`);
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2), ROWS = Number(a.rows ?? 500);
if (![SAMPLES, WARMUP, ROWS].every((n) => Number.isInteger(n) && n >= 0) || SAMPLES < 1) usage('--samples, --warmup and --rows must be non-negative integers (samples >= 1)');
const MIN_SAMPLES = 20;
const BUDGET = 200;
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc08-measure-work'));
if (!(work + '/').startsWith(join(REPO, '.local') + '/')) usage(`--work ${work} must lie inside ${join(REPO, '.local')}`);

ensureOffline(import.meta.filename);
mkdirSync(out, { recursive: true });

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { startCanary } = await import('../../tests/e2e/pilot/lib/canary.mjs');
const { launch, newPage } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { isolatedBuild } = await import('../../tests/e2e/pilot/lib/isolated-build.mjs');
const { ConfigError, loadConfig, v5Package } = await import('../../tests/e2e/pilot/v5/fixture.mjs');
const { mainCase } = await import('../../tests/e2e/litigation/lib/cases.mjs');

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc08: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
let fx;
try { fx = await loadConfig(a.config ? resolve(a.config) : undefined); } catch (e) { console.error(`cc08: ${e.message}`); process.exit(e instanceof ConfigError ? 2 : 1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const rev = (r) => { const p = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${r}^{commit}`], { encoding: 'utf8' }); if (p.status !== 0) usage(`unknown revision ${r}`); return p.stdout.trim(); };
const candidate = rev(a.candidate ?? 'HEAD');
const RV = fx.accepted.resultsVersion;
const { VIEWS } = await import(join(REPO, 'src', 'lib', 'components', 'view-registry.ts'));
const LIT = VIEWS.filter((v) => v.category === 'litigation');

/** Saves measured: the view, its form fields (selector -> synthetic text), its Add button and its rows. */
const SAVES = [
	{ id: 'saveHeads', view: 'heads_tab', action: 'add', fields: { head: 'Measured heading', sub: 'Measured submission', auth: 'Invented authority', ref: 'OD-001' }, inputs: { '#hd_head': 'head', '#hd_sub': 'sub', '#hd_auth': 'auth', '#hd_ref': 'ref' }, add: '#hd-add-button', rows: '#heads-table tbody tr[data-row]' },
	{ id: 'saveAuthorities', view: 'authorities_tab', action: 'add', fields: { topic: 'Measured topic', authority: 'Invented authority', proposition: 'Measured proposition' }, inputs: { '#au_topic': 'topic', '#au_auth': 'authority', '#au_prop': 'proposition' }, add: '#au-add-button', rows: '#auth-table tbody tr' },
	{ id: 'saveCrossexam', view: 'crossexam_tab', action: 'add', fields: { witness: 'Measured witness', topic: 'Measured topic', put: 'Measured put', docs: 'OD-002' }, inputs: { '#cx_w': 'witness', '#cx_t': 'topic', '#cx_put': 'put', '#cx_docs': 'docs' }, add: '#cx-add-form', rows: '#cx-table tbody tr[data-row]' },
];

const INIT = `(() => {
	const cc = window.__cc = { mark: null, pending: false, want: null, t0: null };
	const ok = () => { const w = cc.want; if (!w) return false;
		if (w.kind === 'ready') return document.querySelector('main#main')?.dataset.ready === w.view && location.pathname.endsWith(w.route);
		return document.querySelectorAll(w.rows).length === w.n && !document.querySelector('[role=alert].error'); };
	const check = () => { if (cc.want && !cc.pending && ok()) { cc.pending = true; const seen = performance.now(); requestAnimationFrame(() => { const frame = performance.now(); const ch = new MessageChannel(); ch.port1.onmessage = () => { cc.mark = { at: performance.now(), seen, frame }; }; ch.port2.postMessage(0); }); } };
	cc.arm = (w) => { cc.want = w; cc.mark = null; cc.pending = false; cc.t0 = null; check(); };
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	document.addEventListener('click', (e) => { if (cc.want && e.target.closest && e.target.closest(cc.want.trigger)) cc.t0 = e.timeStamp; }, true);
})()`;

async function measure() {
	const r = { revision: candidate };
	console.log(`candidate: isolated build of ${candidate.slice(0, 12)} ...`);
	const b = isolatedBuild({ repo: REPO, rev: candidate, dir: join(work, `rev-${candidate.slice(0, 12)}`), log: (m) => console.log(m) });
	r.build = { stamp: b.stamp, buildMs: Math.round(b.buildMs), root: b.src, lockSha256: b.lockSha256, mode: 'isolated copy (git archive + reflinked node_modules after bun.lock identity check, bun run --bun build)' };
	const port = PORTS.first + 60, origPort = port + 1;
	const srv = await startServer({ root: b.src, port, origPort, dataDir: join(work, 'data'), buildDir: b.buildDir, logFile: join(out, `server-cc08-${candidate.slice(0, 12)}.log`) });
	const c = client(port);
	const origin = `http://127.0.0.1:${port}`;
	const br = await launch({ profileRoot: join(work, 'profiles') });
	try {
		// the real v5 sample, imported and activated through the app's forms
		console.log('converting the v5 main HTML with GRS-10\'s converter and importing it ...');
		const pkgRun = v5Package(fx, join(work, 'pkg-v5'));
		if (pkgRun.exit !== 0) throw new Error(`conversion failed: ${pkgRun.stderr}`);
		const imp = await c.importPkg(fx.caseFolder, pkgRun.dir);
		if (!Number.isInteger(imp.importId)) throw new Error(`import failed: ${imp.status}`);
		await c.activate(imp.importId, { ack: true });
		if ((await c.activeVersion()) !== RV) throw new Error('the v5 sample did not become active');
		// the synthetic case with ROWS saved rows per measured register, entered through each view's own form action
		console.log(`synthetic case with ${ROWS} saved rows per register ...`);
		const syn = await mainCase(join(work, 'synthetic'));
		const simp = await c.importPkg(syn.caseDir, syn.pkgDir);
		await c.activate(simp.importId, { ack: true });
		const t0 = performance.now();
		for (const s of SAVES) {
			const path = `${vpath(syn.resultsVersion)}${VIEWS.find((v) => v.id === s.view).route}?/${s.action}`;
			for (let i = 0; i < ROWS; i++) {
				const res = await c.form(path, Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, `${v} ${i + 1}`])), { accept: 'application/json', 'x-sveltekit-action': 'true' });
				if (res.status !== 200 || !/"type":"success"/.test(res.text)) throw new Error(`seeding ${s.view} row ${i + 1}: ${res.status} ${res.text.slice(0, 200)}`);
			}
		}
		r.seedMs = Math.round(performance.now() - t0);

		const P = await newPage(br, { initScript: INIT });
		await P.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
		const box = (sel) => P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		const click = async (sel) => { const xy = await box(sel); if (!xy) throw new Error(`no ${sel}`); await P.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y }); for (const type of ['mousePressed', 'mouseReleased']) await P.s('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); };
		const waitMark = () => P.waitFor(`window.__cc.mark && window.__cc.t0 !== null && { at: window.__cc.mark.at, seen: window.__cc.mark.seen, frame: window.__cc.mark.frame, t0: window.__cc.t0 }`, 30000);
		const sample = (m, i, extra = {}) => ({ i, warmup: i < WARMUP, ms: +(m.at - m.t0).toFixed(1), conditionSeenMs: +(m.seen - m.t0).toFixed(1), frameMs: +(m.frame - m.t0).toFixed(1), ...extra });

		// warm navigation through the seven litigation views of the real sample
		console.log('warm navigation ...');
		const nav = [];
		await P.navigate(`${origin}${vpath(RV)}${LIT[0].route}`);
		await P.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(LIT[0].id)}`, 30000);
		for (let i = 0, at = 0; i < WARMUP + SAMPLES; i++) {
			const to = LIT[(at + 1) % LIT.length];
			await P.evaluate(`window.__cc.arm(${JSON.stringify({ kind: 'ready', view: to.id, route: to.route, trigger: `#nav-${to.id}` })})`);
			await click(`#nav-${to.id}`);
			nav.push(sample(await waitMark(), i, { view: to.id }));
			at = (at + 1) % LIT.length;
		}
		const fullLoads = await P.evaluate(`performance.getEntriesByType('navigation').length`);

		// saves on the synthetic case with ROWS saved rows
		const saves = {};
		for (const s of SAVES) {
			console.log(`${s.id} ...`);
			await P.navigate(`${origin}${vpath(syn.resultsVersion)}${VIEWS.find((v) => v.id === s.view).route}`);
			await P.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(s.view)}`, 30000);
			const raw = [];
			const before = await P.evaluate(`document.querySelectorAll(${JSON.stringify(s.rows)}).length`);
			for (let i = 0; i < WARMUP + SAMPLES; i++) {
				const n = await P.evaluate(`document.querySelectorAll(${JSON.stringify(s.rows)}).length`);
				for (const [sel, k] of Object.entries(s.inputs)) await P.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(`${s.fields[k]} m${i + 1}`)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
				await P.evaluate(`window.__cc.arm(${JSON.stringify({ kind: 'rows', rows: s.rows, n: n + 1, trigger: s.add })})`);
				await click(s.add);
				raw.push(sample(await waitMark(), i, { rowsBefore: n }));
			}
			saves[s.id] = { raw, rowsAtStart: before };
		}
		r.raw = { warmNavigation: nav, ...Object.fromEntries(Object.entries(saves).map(([k, v]) => [k, v.raw])) };
		r.notes = { warmNavigationFullDocumentLoads: fullLoads, savedRowsAtStart: Object.fromEntries(Object.entries(saves).map(([k, v]) => [k, v.rowsAtStart])) };
		await P.close();
	} finally {
		await br.close().catch(() => {});
		await srv.stop().catch(() => {});
	}
	r.metrics = {};
	for (const k of ['warmNavigation', ...SAVES.map((s) => s.id)]) {
		const s = stats(r.raw[k].filter((x) => !x.warmup).map((x) => x.ms));
		r.metrics[k] = { ...s, discardedWarmup: r.raw[k].filter((x) => x.warmup).length, budgetP95Ms: BUDGET, enoughSamples: s.n >= MIN_SAMPLES, pass: s.n >= MIN_SAMPLES && s.p95Ms <= BUDGET };
	}
	r.status = Object.values(r.metrics).every((m) => m.pass) ? 'PASS' : 'FAIL';
	return r;
}

const canary = await startCanary();
const result = {
	ticket: 'CC-08', startedAt: new Date().toISOString(), command: `bun scripts/measure/index.ts ${process.argv.slice(2).join(' ')}`,
	worktree: gitIdentity(), host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), offline: proof,
	buildEvidence: process.env.CLEARCASE_BUILD_EVIDENCE ?? null,
	fixture: { navigation: { sample: 'v5 main HTML (real sample)', docCount: fx.summary.mainHtml.docCount, views: LIT.map((v) => v.id) }, saves: { sample: 'synthetic case (GRS-10 converter)', savedRowsPerRegister: ROWS, registers: SAVES.map((s) => s.view) } },
	method: { samples: SAMPLES, warmup: WARMUP, minSamples: MIN_SAMPLES, percentile: 'nearest-rank over the kept samples', budgetP95Ms: BUDGET, clock: "the page's performance.now(): click event timeStamp to the mark", nextFrame: 'a MutationObserver (installed before page scripts) sees the condition; the mark is taken in a task posted (MessageChannel) from the next requestAnimationFrame callback' },
};
let failure = null;
try { result.candidate = await measure(); } catch (e) { failure = e; result.error = String(e?.stack ?? e).slice(0, 2000); }
await canary.close().catch(() => {});
// Chromium's own background services are counted apart (as the pilot suite does); any other hit fails the run
const { isBackground } = await import('../../tests/e2e/pilot/suite/context.mjs');
const canaryHits = canary.hits.filter((h) => !isBackground(h)).length;
result.canaryHits = { other: canaryHits, browserBackground: canary.hits.length - canaryHits };
writeFileSync(join(out, 'measure-CC-08.json'), JSON.stringify(result, null, 1) + '\n');
if (!a.keep) rmSync(work, { recursive: true, force: true });
const m = result.candidate?.metrics ?? {};
for (const [k, v] of Object.entries(m)) console.log(`cc08: ${k.padEnd(16)} n ${v.n} p50 ${v.p50Ms} ms p95 ${v.p95Ms} ms (budget ${v.budgetP95Ms}) ${v.pass ? 'PASS' : 'FAIL'}`);
console.log(`cc08: fixture: v5 sample ${result.fixture.navigation.docCount} documents (navigation); synthetic case with ${ROWS} saved rows per register (saves) -> ${join(out, 'measure-CC-08.json')}`);
const ok = !failure && result.candidate?.status === 'PASS' && canaryHits === 0;
console.log(`cc08: ${ok ? 'PASS' : 'FAIL'}${failure ? ` (${String(failure.message ?? failure).slice(0, 300)})` : ''}${canaryHits ? ` (${canaryHits} canary hits)` : ''}`);
process.exit(ok ? 0 : 1);
