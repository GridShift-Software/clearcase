// Runs INSIDE the offline network namespace (tests/e2e/pilot/offline.sh), started by main.mjs:
//   bun inner.mjs CONFIG.json
// Proves the namespace is offline, builds the synthetic case, boots the isolated build's scripts/pilot/start.ts under
// Bun, runs the live doctor (and its negative controls against the same server), drives every step of drive.mjs (the
// pilot's and the discovered features/*.steps.mjs) in Chromium, checks the canary, and stops the server and browser it started. Results: <evidence>/inner.json.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDoctor, liveDoctor } from './live-doctor.mjs';
import { steps as allSteps } from './drive.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const L = (rel) => import(join(cfg.harness, rel));
const { proveOffline } = await L('netproof.mjs');
const { startServer } = await L('server.mjs');
const { launch, newPage, frameEvaluator, sleep } = await L('cdp.mjs');
const { startCanary } = await L('canary.mjs');
const { client } = await L('client.mjs');
const { buildCase, pdf } = await import(cfg.fixtures);

const ev = cfg.evidence;
mkdirSync(join(ev, 'screens'), { recursive: true });
const pid = (role, p) => appendFileSync(cfg.pidFile, JSON.stringify({ role, pid: p, at: new Date().toISOString() }) + '\n');
pid('inner', process.pid);
const results = [];
let failed = false;
// inner.json is rewritten after every step (ok: null until the end), so a killed run still shows how far it got.
const save = (ok = null) => writeFileSync(join(ev, 'inner.json'), JSON.stringify({ ok, partial: ok === null, pid: process.pid, ports: cfg.ports, results }, null, 1));
const step = async (id, title, fn, { feature = null } = {}) => {
	if (failed) { results.push({ id, feature, title, status: 'NOT RUN' }); console.log(`NOT RUN ${id}`); return null; }
	const t0 = Date.now();
	try {
		const evidence = await fn();
		results.push({ id, feature, title, status: 'PASS', ms: Date.now() - t0, evidence });
		save();
		console.log(`PASS    ${id} ${title}`);
		return evidence;
	} catch (e) {
		failed = true;
		results.push({ id, feature, title, status: 'FAIL', ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 4000) });
		save();
		console.log(`FAIL    ${id} ${title}\n        ${String(e?.message ?? e).slice(0, 600)}`);
		return null;
	}
};

const app = `http://127.0.0.1:${cfg.ports.app}`;
const orig = `http://clearcase-originals.localhost:${cfg.ports.originals}`;
let srv = null, b = null, canary = null, synth = null;
let shotN = 0;

await step('net-offline', 'only lo exists; outbound TCP and DNS fail; loopback accepts', async () => {
	const r = await proveOffline();
	if (!r.pass) throw new Error(`not offline: ${JSON.stringify(r)}`);
	return r;
});

await step('synthetic-case', 'build the synthetic case folder and results package (GRS-10 converter, invented data)', async () => {
	// OD-001, the narrative's citation, gets a real one-page PDF so the viewer has something to render.
	const agreement = pdf('Synthetic agreement OD-001');
	let rows = 0;
	synth = await buildCase(cfg.caseRoot, {
		caseId: 'verify-clearcase',
		originals: { 'DISCOVERY A/OD-001 Supply agreement.pdf': agreement },
		edit: (r) => { r.DATA.chronology.find((x) => x.ref === 'OD-001').size = agreement.byteLength; rows = r.DATA.chronology.length; },
	});
	synth.rows = rows;
	return { caseDir: synth.caseDir, pkgDir: synth.pkgDir, resultsVersion: synth.resultsVersion, rows: synth.rows, diagnostics: synth.diagnostics.map((d) => d.code) };
});

await step('boot', 'start scripts/pilot/start.ts of the isolated build under Bun on this run\'s ports and data directory', async () => {
	srv = await startServer({ root: cfg.src, port: cfg.ports.app, origPort: cfg.ports.originals, dataDir: cfg.dataDir, buildDir: cfg.buildDir, logFile: join(ev, 'server.log') });
	pid('server', srv.pid);
	return { pid: srv.pid, readyMs: Math.round(srv.readyMs), startScript: join(cfg.src, 'scripts', 'pilot', 'start.ts') };
});

const expect = () => ({
	pid: srv.pid, dataDir: cfg.dataDir, appPort: cfg.ports.app, originalsPort: cfg.ports.originals, originalsOrigin: orig,
	build: cfg.stamp, bun: cfg.bunPin, startScript: join(cfg.src, 'scripts', 'pilot', 'start.ts'),
});

await step('live-doctor', 'the instance on the app port is this run\'s: pid, data dir, ports, build stamp, Bun pin, pragmas, no storage error', async () => {
	const r = await liveDoctor({ url: app, expect: expect() });
	writeFileSync(join(ev, 'health.json'), JSON.stringify(r.health, null, 1));
	console.log(formatDoctor(r));
	if (!r.pass) throw new Error(`live doctor failed: ${r.checks.filter((c) => !c.pass).map((c) => c.name).join(', ')}`);
	return { checks: r.checks.length, health: 'health.json' };
});

await step('live-doctor-negative', 'the same doctor FAILS when it expects another build, data directory or process', async () => {
	const e = expect();
	const controls = {
		'other data dir': { ...e, dataDir: join(cfg.dataDir, '..', 'another-data-dir') },
		'other build': { ...e, build: { ...e.build, buildId: '0000000000000000', revision: '0'.repeat(40) } },
		'other process': { ...e, pid: process.pid },
		'other bun': { ...e, bun: '1.4.1' },
	};
	const out = {};
	for (const [name, exp] of Object.entries(controls)) {
		const r = await liveDoctor({ url: app, expect: exp });
		out[name] = { pass: r.pass, failed: r.checks.filter((c) => !c.pass).map((c) => c.name) };
		if (r.pass) throw new Error(`the live doctor passed for "${name}"`);
	}
	return out;
});

await step('browser', 'launch Chromium (own profile; every non-loopback host maps to the canary)', async () => {
	canary = await startCanary();
	// Chromium's own network-time query (clients2.google.com/time) is browser background traffic the canary would
	// record; the last --disable-features switch wins, so this repeats the harness's list and adds that feature.
	const disable = 'Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater,NetworkTimeServiceQuerying';
	b = await launch({ profileRoot: cfg.profileDir, extra: [`--disable-features=${disable}`] });
	pid('chromium', b.proc.pid);
	return { pid: b.proc.pid, canaryPort: Number(process.env.CANARY_PORT) };
});

if (!failed) {
	const page = await newPage(b);
	const ev1 = (sid) => async (expression) => {
		const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const waitOn = (evaluate) => async (expr, timeout = 15000) => {
		const t0 = Date.now();
		let last;
		for (;;) {
			try { const v = await evaluate(expr); if (v) return v; last = v; } catch (e) { last = String(e); }
			if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms): ${expr.slice(0, 200)} last=${String(last).slice(0, 200)}`);
			await sleep(25);
		}
	};
	const x = {
		page, b, app, orig, synth, state: {}, c: client(cfg.ports.app),
		click: (sel) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.click(); return true; })()`),
		fill: (sel, value) => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`),
		text: (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`),
		waitReady: (v, t = 30000) => page.waitFor(`document.querySelector('main')?.dataset.ready === ${JSON.stringify(v)}`, t),
		async shot(name, sid = page.sessionId) {
			const { data } = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
			const rel = join('screens', `${String(++shotN).padStart(2, '0')}-${name}.png`);
			writeFileSync(join(ev, rel), Buffer.from(data, 'base64'));
			return rel;
		},
		tab: (sid) => ({ evaluate: ev1(sid), waitFor: waitOn(ev1(sid)) }),
		frame: (sid, re) => frameEvaluator(b, sid, re),
		/** Click a link that opens a new browsing context; resolves to the new tab's CDP session id. */
		async openTab(sel, urlPrefix) {
			const known = new Set(b.sessions.keys());
			await x.click(sel);
			for (let i = 0; i < 400; i++) {
				for (const [sid, info] of b.sessions) if (!known.has(sid) && info.type === 'page' && info.url.startsWith(urlPrefix)) { await b.send('Page.enable', {}, sid).catch(() => {}); return sid; }
				await sleep(25);
			}
			throw new Error(`clicking ${sel} opened no tab at ${urlPrefix}…`);
		},
	};
	// the pilot's steps and the discovered features/<feature>.steps.mjs (main.mjs has checked them before the build)
	for (const s of await allSteps()) await step(s.id, s.title, () => s.run(x), { feature: s.feature });
}

await step('no-egress', 'the canary saw no connection and the browser requested only the app and originals origins', async () => {
	const allowed = (u) => u.startsWith(app + '/') || u.startsWith(orig + '/') || /^(data|blob|about):/.test(u);
	const stray = b.events.requests.map((r) => r.url).filter((u) => !allowed(u));
	if (canary.hits.length || stray.length) throw new Error(`egress attempts: canary ${JSON.stringify(canary.hits)}, requests ${JSON.stringify(stray)}`);
	return { canaryHits: 0, requests: b.events.requests.length, dialogs: b.events.dialogs.length, consoleErrors: b.events.console.filter((c) => /error|exception/.test(c.kind)).slice(0, 20) };
});

// Teardown of what this process started, whatever failed above: browser, canary, server (graceful first).
const teardown = {};
if (b) { await b.close().catch((e) => { teardown.browser = String(e); }); teardown.browser ??= 'closed'; }
if (canary) await canary.close().catch(() => {});
if (srv) teardown.server = await srv.stop().catch((e) => ({ error: String(e) }));
const stopped = !srv || (teardown.server?.graceful && teardown.server.appPort !== true && teardown.server.origPort !== true);
results.push({ id: 'stop', title: 'stop the server (SIGTERM, graceful) and the browser; both ports closed', status: stopped ? 'PASS' : 'FAIL', evidence: teardown });
const ok = !failed && stopped && results.every((r) => r.status === 'PASS');
save(ok);
process.exit(ok ? 0 : 1);
