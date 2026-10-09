#!/usr/bin/env bun
// Offline browser suite of the local pilot (GRS-12), run by `bun run --bun test:e2e` inside its own network namespace:
//   unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh bun tests/e2e/pilot/suite.mjs
// Every server is the production entry (bun scripts/pilot/start.ts) of E2E_ROOT (default: this worktree) on the build
// in E2E_BUILD_DIR (default: <root>/build). Synthetic data only (lib/fixtures.ts through GRS-10's converter). The run
// fails unless the offline proof passes, every scenario passes, and no real canary hit or off-origin request happened
// outside a labelled positive control. Results: $CLEARCASE_E2E_OUT/suite.json (lib/record.mjs).
// Ports: app/originals 43000-43298, canary 43299 (CANARY_PORT). E2E_STOP_AFTER=<id> ends a development run early (recorded as a PARTIAL failure).
process.env.CANARY_PORT ??= '43299';
const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { proveOffline } = await import('./lib/netproof.mjs');
const { recorder } = await import('./lib/record.mjs');
const { CHROME, CANARY_PORT, launch } = await import('./lib/cdp.mjs');
const { startCanary } = await import('./lib/canary.mjs');
const { bunIdentity } = await import('./lib/server.mjs');
const { hostileOriginals } = await import('./lib/fixtures.ts');
const { PORTS, appServer, helperSites, ledger } = await import('./suite/context.mjs');
const { mainCase } = await import('./suite/cases.mjs');
const flow = await import('./suite/main-flow.mjs');
const sec = await import('./suite/security.mjs');
const state = await import('./suite/state.mjs');
const hostile = await import('./suite/hostile.mjs');

const ROOT = resolve(process.env.E2E_ROOT ?? join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const stamp = existsSync(join(BUILD, 'clearcase-build.json')) ? JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')) : null;
const R = recorder('suite', { bun: bunIdentity(), root: ROOT, build: BUILD, buildStamp: stamp, chromium: CHROME, ports: PORTS, canaryPort: CANARY_PORT });
const STOP = process.env.E2E_STOP_AFTER ?? null;
let stopped = false;
const step = async (id, title, fn) => { if (stopped) return; await R.step(id, title, fn); if (id === STOP) stopped = true; };

const offline = await proveOffline();
R.rec('NET-OFFLINE', 'the run is offline: only lo, outbound TCP and DNS fail, loopback works (proveOffline)', offline.pass ? 'PASS' : 'FAIL', offline);
if (!offline.pass || CANARY_PORT !== PORTS.CANARY) {
	if (CANARY_PORT !== PORTS.CANARY) R.rec('NET-CANARY-PORT', `canary port must be ${PORTS.CANARY}`, 'FAIL', { CANARY_PORT });
	process.exit(R.finish() ? 0 : 1);
}

const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-suite-'));
// An interrupted run still removes its temp root (servers and Chromium are killed by the libs' exit hooks).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const ctx = {
	R, ROOT, BUILD, tmp,
	A: appServer({ name: 'a', root: ROOT, buildDir: BUILD, port: PORTS.A, origPort: PORTS.A_ORIG, dir: tmp }),
	B: appServer({ name: 'b', root: ROOT, buildDir: BUILD, port: PORTS.B, origPort: PORTS.B_ORIG, dir: tmp }),
	caseName: (sc) => { const m = JSON.parse(new TextDecoder().decode(sc.files.get('manifest.json'))); return m.case.label || m.case.id; },
};
let canary, b, sites;
try {
	canary = await startCanary();
	sites = ctx.sites = helperSites(hostileOriginals()['HOSTILE/HX-005 open-action.pdf']);
	b = ctx.b = await launch({ profileRoot: join(tmp, 'chromium') });
	ctx.L = ledger(b, canary);
	const t0 = Date.now();
	await step('NET-CANARY', 'positive control (labelled): a page request to a non-loopback host reaches the canary, never the network', () => sec.canaryControl(ctx));

	await ctx.A.start();
	ctx.main = await mainCase(join(tmp, 'main'));
	await step('S1b', 'Preview of the imported candidate shows the candidate banner and the document count; preview never activates', () => flow.s1(ctx));
	await step('ACT', 'activation through the UI: refused without the acknowledgement (ACK_REQUIRED, nothing changes); with it the version is active', () => flow.activation(ctx));
	await step('CHRON', 'chronology in the browser: filters (incl. a non-standard bundle, type, status, text), stable sorts (date asc/desc, amount with empty = 0), row count', () => flow.chronology(ctx));
	await step('S25', 'chronology grid: div rows with content-visibility:auto; per-version JSON private, no-cache, ETag = read-model digest, 304', () => flow.s25(ctx));
	await step('CITE', 'citations: [[REF]] and [[REF#p2]] are client-side app links; Open shows the PDF in the sandboxed viewer, at page 2 for #p2', () => flow.citations(ctx));
	await step('BA-14', 'keyboard: skip link first (no history entry), Tab + Enter on nav links, heading focused after each navigation and after Back (also after the skip link, across a full load and from an in-page #code- fragment link), one history entry each', () => flow.keyboard(ctx));
	await step('BA-16', "titles: '<document> · <section> · <case> · ClearCase' for overview, chronology, a document and an unavailable view", () => flow.titles(ctx));
	await step('BA-18', '42 nav entries in registry order with inventory labels; each heading equals its label; 40 unavailable views name their GRS owner; unknown views 404', () => flow.views42(ctx));
	await step('SLOTS', "overview widget slots: deadlines, unbilled-time and rescan-freshness render data-slot-status=unavailable naming GRS-17/GRS-20; the old combined card is gone", () => flow.overviewSlots(ctx));
	await step('BA-04', "date basis column hidden while no row has a basis ('undated' in the Date column); with supplied date_type/date_source, 'unknown', 'undated' and the supplied values", () => flow.dateBasis(ctx));
	await step('BA-09', 'source routes: e-mail original direct, attachments through the parent; an original deleted before import, or after activation, is unavailable, has no link and is 410; restoring it brings the links back', () => flow.sourceRoutes(ctx));
	await step('S4', 'a note added through the document page form appears without a reload, renders as text and persists', () => state.notesUi(ctx));
	await step('S28', 'viewer containment: script in the sandboxed pdf.js frame cannot navigate, open popups, read originals, set cookies or reach the wrapper', () => sec.s28(ctx));
	await step('S29', '/_pdfjs allowlist: inherited keys and malformed escapes 404 with CSP; listed files 200', () => sec.s29(ctx));
	await step('S24', 'app origin: CSP with nonce and no unsafe-inline script source, same-origin referrer, no-store, no CSP violations; no-JS import works; cross-site POST and API refused', () => sec.s24(ctx));
	await step('S14', 'foreign Host gets 421 on pages, /api and static assets of the app origin, and on the originals origin', () => sec.s14(ctx));
	await step('S63', 'POST ?/default is 400; pages are Cache-Control no-store with the skip link first', () => sec.s63(ctx));
	await step('S57', 'cookies set by another localhost app never reach clearcase-originals.localhost', () => sec.s57(ctx));
	await step('S62', 'cross-site frames and fetches of originals get one constant 403 (existing or missing); with the link capability a cross-site top-level navigation works', () => sec.s62(ctx));
	await step('S27', 'v2 activates with the S4 note still shown (S8); rollback from the overview returns to the previous version (activation_log kind rollback); a replayed rollback is 409, six concurrent identical ones apply once (S60), and Back shows the current state', () => state.rollback(ctx));
	await step('S18', 'links rendered before a restart still work cross-site after it (link key persisted in the data directory, 0600)', () => state.restartLinks(ctx));
	await step('BFCACHE', 'Back after leaving a page: restored from bfcache without reload when nothing changed; reloaded with the new state when something did', () => state.bfcache(ctx));

	await step('S13', 'hostile package: candidate, activation with ack, inert rendering everywhere, hostile originals never execute in any frame or tab', () => hostile.s13(ctx));
	await step('CSP-CONSOLE', 'no Content-Security-Policy violation was reported by any app page during the run', () => sec.cspConsole(ctx));
	if (!stopped || STOP === 'S13') await step('NET-ZERO', 'no real canary hit and no off-origin request from any page, frame or worker during the run (controls excluded and labelled)', () => sec.netZero(ctx, t0));
	if (STOP) R.rec('PARTIAL', `development run stopped after ${STOP} (E2E_STOP_AFTER): not a complete run`, 'FAIL', { stopAfter: STOP });
} catch (e) {
	R.rec('HARNESS', 'suite harness', 'FAIL', { error: String(e?.stack ?? e).slice(0, 4000) });
} finally {
	for (const s of [ctx.A, ctx.B]) {
		const st = await s.stop().catch((e) => ({ error: String(e) }));
		if (st && !st.graceful && !st.error) R.rec(`STOP-${s.name.toUpperCase()}`, `server ${s.name} stops gracefully on SIGTERM`, 'FAIL', st);
	}
	await b?.close().catch(() => {});
	await sites?.close().catch(() => {});
	await canary?.close().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(R.finish() ? 0 : 1);
