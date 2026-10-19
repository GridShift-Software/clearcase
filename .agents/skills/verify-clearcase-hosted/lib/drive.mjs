// The Chromium drive, INSIDE the offline namespace, started by inner.mjs (through $CLEARCASE_BROWSER_LOCK when set):
//   bun drive.mjs CONFIG.json
// Launches Chromium with every non-loopback host mapped to the canary, runs steps.mjs against the running server, then
// requires that nothing but the app's loopback origin was requested. Writes <evidence>/drive.json; exit 0 only when
// every step passed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { steps } from './steps.mjs';
import { DRIVE_STEPS } from './evidence.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.env.CANARY_PORT = String(cfg.ports.canary);
const L = (rel) => import(join(cfg.harness, rel));
const { launch, newPage } = await L('cdp.mjs');
const { startCanary } = await L('canary.mjs');
const { isBackground } = await L('../suite/context.mjs');
const { gateFixture } = await import(cfg.fixtureModule);

const ev = cfg.evidence;
mkdirSync(join(ev, 'screens'), { recursive: true });
appendFileSync(cfg.pidFile, JSON.stringify({ role: 'drive', pid: process.pid, at: new Date().toISOString() }) + '\n');
const startedAt = Date.now();
const results = [];
let failed = false, shotN = 0, b = null, canary = null;
const save = (ok = null) => writeFileSync(join(ev, 'drive.json'), JSON.stringify({ ok, partial: ok === null, startedAt, results }, null, 1));
// The slot wait happens before this process starts, so the deadline counts the drive alone.
setTimeout(() => { console.log('drive: not finished within 300 s'); save(false); process.exit(1); }, 300_000).unref();
const step = async (id, feature, title, fn) => {
	if (failed) { results.push({ id, feature, title, status: 'NOT RUN' }); return; }
	const t0 = Date.now();
	try {
		const evidence = await fn();
		results.push({ id, feature, title, status: 'PASS', ms: Date.now() - t0, evidence });
		console.log(`PASS    ${id} ${title}`);
	} catch (e) {
		failed = true;
		results.push({ id, feature, title, status: 'FAIL', ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 4000) });
		console.log(`FAIL    ${id} ${title}\n        ${String(e?.message ?? e).slice(0, 600)}`);
	}
	save();
};

await step('browser', null, 'launch Chromium (own profile; every non-loopback host maps to the canary)', async () => {
	canary = await startCanary();
	const disable = 'Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater,NetworkTimeServiceQuerying';
	b = await launch({ profileRoot: cfg.profileDir, extra: [`--disable-features=${disable}`] });
	appendFileSync(cfg.pidFile, JSON.stringify({ role: 'chromium', pid: b.proc.pid, at: new Date().toISOString() }) + '\n');
	return { pid: b.proc.pid, canaryPort: cfg.ports.canary };
});

if (!failed) {
	const page = await newPage(b);
	const on = (p) => p ?? page;
	const x = {
		page, b, app: cfg.app, fixture: gateFixture(), state: {},
		newPage: (opts) => newPage(b, opts),
		click: (sel, p) => on(p).evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.click(); return true; })()`),
		select: (sel, value, p) => on(p).evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); if (e.value !== ${JSON.stringify(value)}) throw new Error('no option ' + ${JSON.stringify(value)}); return e.value; })()`),
		async shot(name, p) {
			const { data } = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, on(p).sessionId);
			const rel = join('screens', `${String(++shotN).padStart(2, '0')}-${name}.png`);
			writeFileSync(join(ev, rel), Buffer.from(data, 'base64'));
			return rel;
		},
		save(rel, bytes) {
			mkdirSync(dirname(join(ev, rel)), { recursive: true });
			writeFileSync(join(ev, rel), bytes);
			return rel;
		},
		/** fetch(path) from the page itself, with the page's cookies: status, headers, size, sha256 and whether the body is a PDF or names a synthetic record. */
		inPageFetch: (path, init = {}, p) => on(p).evaluate(`(async () => {
			const res = await fetch(${JSON.stringify(path)}, ${JSON.stringify(init)});
			const buf = new Uint8Array(await res.arrayBuffer());
			const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((n) => n.toString(16).padStart(2, '0')).join('');
			const text = new TextDecoder().decode(buf);
			return { status: res.status, headers: Object.fromEntries(res.headers), size: buf.length, sha256: hex, pdf: text.startsWith('%PDF-'), synthetic: text.includes('Synthetic') };
		})()`),
	};
	for (const s of steps) await step(s.id, s.feature, s.title, () => s.run(x));
}

await step('no-egress', null, 'the canary saw no connection but Chrome\'s own background services, and the browser requested only the app\'s loopback origin', async () => {
	const allowed = (u) => u.startsWith(cfg.app + '/') || /^(data|blob|about):/.test(u);
	const stray = b.events.requests.map((r) => r.url).filter((u) => !allowed(u));
	const hits = canary.hits.filter((h) => !isBackground(h));
	if (hits.length || stray.length) throw new Error(`egress attempts: canary ${JSON.stringify(hits)}, requests ${JSON.stringify(stray)}`);
	return { canaryHits: 0, backgroundHits: canary.hits.map((h) => h.sni ?? h.host), requests: b.events.requests.length, origins: [...new Set(b.events.requests.map((r) => new URL(r.url).origin))], consoleErrors: b.events.console.filter((c) => /error|exception/.test(c.kind)).slice(0, 20) };
});

if (b) await b.close().catch(() => {});
if (canary) await canary.close().catch(() => {});
const ok = !failed && DRIVE_STEPS.every((id) => results.some((r) => r.id === id && r.status === 'PASS'));
save(ok);
process.exit(ok ? 0 : 1);
