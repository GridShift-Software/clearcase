#!/usr/bin/env bun
// CC-07 (GRS-17) register save and read latency, offline, on this host, against the production build of one revision
// under Bun with a SYNTHETIC case (no case material):
//
//   bun run --bun measure --ticket CC-07 [--candidate REV (default HEAD)] [--samples 20] [--warmup 2] [--rows 500]
//       [--out DIR] [--work DIR] [--keep]
//
// The revision under test is built in an isolated copy (tests/e2e/pilot/lib/isolated-build.mjs); ./build is never
// measured. A synthetic case (tests/e2e/pilot/lib/fixtures.ts, GRS-10's converter) is imported and activated, then
// every register gets --rows synthetic entries through its own save action over HTTP. Per register, after --warmup
// discarded samples, at least --samples samples of:
//   save  the register page open with its rows; the form filled; a real mouse click on Save (the click event's
//         timeStamp) -> the saved row rendered in the table (one more row), then the next rendered frame.
//   read  one warm tab on the overview; a real click on the register's navigation link (the click event's timeStamp)
//         -> main[data-ready=<view>] with every row rendered, then the next rendered frame (client-side navigation:
//         the server load of all rows, serialisation and rendering).
// "Next rendered frame" as in cc03.mjs: a MutationObserver installed before any page script sees the condition; the
// next requestAnimationFrame callback posts a MessageChannel task, which takes the mark. Percentiles are nearest-rank.
// Budget: p95 <= 200 ms for save and for read, per register. Results: <out>/measure-CC-07.json (default
// $CLEARCASE_REPORT_DIR/measure, else .local/measure). Exit 0 when every budget holds with enough samples, 1 if not,
// 2 on a usage or prerequisite error.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bunIdentity, chromiumIdentity, ensureOffline, gitIdentity, hostIdentity, PORTS, REPO, stats } from '../../tests/e2e/pilot/v5/env.mjs';

const { values: a } = parseArgs({ options: {
	ticket: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' }, rows: { type: 'string' },
	out: { type: 'string' }, work: { type: 'string' }, keep: { type: 'boolean' },
}, strict: true });
const usage = (m) => { console.error(`cc07: ${m}\nusage: measure --ticket CC-07 [--candidate REV] [--samples 20] [--warmup 2] [--rows 500] [--out DIR]`); process.exit(2); };
if (a.ticket && a.ticket !== 'CC-07') usage(`this runner measures CC-07, not ${a.ticket}`);
const SAMPLES = Number(a.samples ?? 20), WARMUP = Number(a.warmup ?? 2), ROWS = Number(a.rows ?? 500);
if (![SAMPLES, WARMUP, ROWS].every((n) => Number.isInteger(n) && n >= 0) || SAMPLES < 1) usage('--samples, --warmup and --rows must be non-negative integers (samples >= 1)');
const MIN_SAMPLES = 20;
const BUDGET = { save: 200, read: 200 };
const out = resolve(a.out ?? (process.env.CLEARCASE_REPORT_DIR ? join(process.env.CLEARCASE_REPORT_DIR, 'measure') : join(REPO, '.local', 'measure')));
const work = resolve(a.work ?? join(REPO, '.local', 'cc07-work'));
if (!(work + '/').startsWith(join(REPO, '.local') + '/')) usage(`--work ${work} must lie inside ${join(REPO, '.local')}`);

ensureOffline(import.meta.filename);
mkdirSync(out, { recursive: true });

const { proveOffline } = await import('../../tests/e2e/pilot/lib/netproof.mjs');
const { launch, newPage, sleep } = await import('../../tests/e2e/pilot/lib/cdp.mjs');
const { client, vpath } = await import('../../tests/e2e/pilot/lib/client.mjs');
const { startServer } = await import('../../tests/e2e/pilot/lib/server.mjs');
const { isolatedBuild } = await import('../../tests/e2e/pilot/lib/isolated-build.mjs');
const { buildCase } = await import('../../tests/e2e/pilot/lib/fixtures.ts');
const { REGISTERS, REGISTER_VIEWS } = await import('../../src/lib/views/registers/defs.ts');

const proof = await proveOffline();
if (!proof.pass) { console.error(`cc07: offline proof failed: ${JSON.stringify(proof)}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const J = JSON.stringify;
const CLOCK = '2026-10-08T09:00:00Z';

/** A synthetic entry n for a register: every field filled by its type (dates spread around the clock). */
function entry(def, n) {
	const day = (o) => new Date(Date.parse(CLOCK) + o * 86400000).toISOString().slice(0, 10);
	return Object.fromEntries(def.fields.map((f) => [f.k, f.type === 'date' ? day((n % 120) - 60) : f.type === 'select' ? f.opts[n % f.opts.length] : f.k === 'hours' || f.k === 'rate' || f.k === 'amount' ? String((n % 17) + 0.5) : `Synthetic ${f.k} ${n}`]));
}

// The mark (the condition is a function created over CDP: the app's CSP forbids eval): condition seen by a MutationObserver -> next requestAnimationFrame -> a MessageChannel task (after paint).
const INIT = `(() => {
	window.__cc = { cond: null, mark: null, armed: null };
	const check = () => { const w = window.__cc; if (!w.armed || w.cond !== null) return; try { if (!w.armed()) return; } catch { return; }
		w.cond = performance.now(); requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { w.mark = performance.now(); }; ch.port2.postMessage(0); }); };
	window.__ccArm = (fn) => { const w = window.__cc; w.cond = null; w.mark = null; w.click = null; w.armed = fn; check(); };
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	addEventListener('click', (e) => { if (window.__cc.armed) window.__cc.click = e.timeStamp; }, true);
})()`;

async function clickAt(p, sel) {
	const r = await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
	if (!r) throw new Error(`no element ${sel}`);
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
}
/** Wait for the armed mark; returns the click -> mark latency in ms. */
async function measured(p) {
	const w = await p.waitFor(`window.__cc.mark !== null && window.__cc.click !== null ? window.__cc : null`, 30000);
	return { ms: w.mark - w.click, toCondMs: w.cond - w.click };
}
const setFields = (p, e) => p.evaluate(`(() => { for (const [k, v] of Object.entries(${J(e)})) { const el = document.getElementById('in-' + k); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
const rowCount = (p) => p.evaluate(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length`);

const result = { ticket: 'CC-07', what: 'register save and read latency (GRS-17)', evidence: process.env.CLEARCASE_BUILD_EVIDENCE === 'true', clock: CLOCK, samples: SAMPLES, warmup: WARMUP, rowsPerRegister: ROWS,
	budgetsMs: BUDGET, percentile: 'nearest-rank p95', host: hostIdentity(), bun: bunIdentity(), chromium: chromiumIdentity(), git: gitIdentity(), offline: proof.pass, registers: {}, ok: false };
let srv, b;
try {
	const build = isolatedBuild({ repo: REPO, rev: a.candidate ?? 'HEAD', dir: join(work, 'build'), log: (m) => console.log(m) });
	result.revision = build.revision;
	result.build = { stamp: build.stamp, buildMs: Math.round(build.buildMs) };
	const sc = await buildCase(join(work, 'case'), { caseId: 'cc07-measure' });
	const port = PORTS.first + 70;
	srv = await startServer({ root: build.src, port, origPort: port + 1, dataDir: join(work, 'data'), buildDir: build.buildDir, logFile: join(work, 'server.log'), env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
	const c = client(port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
	await c.activate(imp.importId);
	const rv = await c.activeVersion();
	if (rv !== sc.resultsVersion) throw new Error('activation of the synthetic case failed');
	const base = `${c.origin}${vpath(rv)}`;
	// the fixture: ROWS entries per register through each register's own save action
	const t0 = performance.now();
	for (const view of REGISTER_VIEWS) {
		for (let n = 0; n < ROWS; n++) {
			const r = await c.form(`${vpath(rv)}/registers/${view}?/save`, entry(REGISTERS[view], n), { accept: 'application/json', 'x-sveltekit-action': 'true' });
			if (r.status !== 200 || !/"type":"success"/.test(r.text)) throw new Error(`fixture save ${view} #${n}: ${r.status} ${r.text.slice(0, 200)}`);
		}
	}
	result.fixtureMs = Math.round(performance.now() - t0);
	b = await launch({ profileRoot: join(work, 'chromium') });
	const p = await newPage(b, { initScript: INIT });
	const ready = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)}`;
	const goto = async (path, cond) => { await p.navigate(`${base}${path}`); await p.waitFor(cond, 30000); };
	for (const view of REGISTER_VIEWS) {
		const def = REGISTERS[view];
		const raw = { save: [], read: [] };
		// read: overview -> register through the navigation link
		await goto(`/registers/${view}`, ready(view));
		const n = await rowCount(p);
		for (let i = 0; i < WARMUP + SAMPLES; i++) {
			await goto('/overview', ready('overview'));
			await p.evaluate(`window.__ccArm(() => ${ready(view)} && document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n})`);
			await clickAt(p, `#nav-${view}`);
			raw.read.push({ ...(await measured(p)), rows: n, warmup: i < WARMUP });
		}
		// save: the register page open, the form filled, Save -> the new row rendered
		await goto(`/registers/${view}`, ready(view));
		const startRows = await rowCount(p);
		for (let i = 0; i < WARMUP + SAMPLES; i++) {
			const n = await rowCount(p);
			await setFields(p, entry(def, ROWS + i));
			await p.evaluate(`window.__ccArm(() => document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n + 1})`);
			await clickAt(p, '#register-save');
			raw.save.push({ ...(await measured(p)), rows: n, warmup: i < WARMUP });
			await p.waitFor(`!document.querySelector('#register-save[disabled]')`, 10000);
			await sleep(20);
		}
		const kept = (xs) => xs.filter((x) => !x.warmup).map((x) => x.ms);
		const st = { save: stats(kept(raw.save)), read: stats(kept(raw.read)) };
		const ok = st.save.n >= MIN_SAMPLES && st.read.n >= MIN_SAMPLES && st.save.p95Ms <= BUDGET.save && st.read.p95Ms <= BUDGET.read;
		result.registers[view] = { store: def.store, rowsAtStart: startRows, ...st, ok, raw };
		console.log(`${view.padEnd(20)} rows ${startRows}  save n=${st.save.n} p95 ${st.save.p95Ms} ms  read n=${st.read.n} p95 ${st.read.p95Ms} ms  ${ok ? 'PASS' : 'FAIL'}`);
	}
	result.ok = REGISTER_VIEWS.every((v) => result.registers[v]?.ok);
} catch (e) {
	result.error = String(e?.stack ?? e).slice(0, 4000);
	console.error(`cc07: ${result.error}`);
} finally {
	await b?.close().catch(() => {});
	await srv?.stop().catch(() => {});
	if (!a.keep) rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(out, 'measure-CC-07.json'), J(result, null, 1));
console.log(`\nCC-07 ${result.revision?.slice(0, 12) ?? '?'} (build ${result.build?.stamp?.buildId ?? '?'}, evidence ${result.evidence}): ${ROWS} rows per register, ${SAMPLES} samples after ${WARMUP} warm-up, budgets save/read p95 <= ${BUDGET.save}/${BUDGET.read} ms: ${result.ok ? 'PASS' : 'FAIL'} -> ${join(out, 'measure-CC-07.json')}`);
process.exit(result.ok ? 0 : 1);
