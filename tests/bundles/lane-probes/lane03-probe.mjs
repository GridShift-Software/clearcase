#!/usr/bin/env bun
// Verification lane 03 (CC-09) probes on a synthetic case. PART=server (no browser) or PART=browser.
// Run inside tests/e2e/pilot/offline.sh. Writes JSON results to .local/lane03/probe-<part>.json.
process.env.CANARY_PORT ??= '43599';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { join, resolve } = await import('node:path');
const ROOT = resolve(import.meta.dirname, '..', '..');
const T = (p) => join(ROOT, 'tests', 'e2e', p);
const { buildCase, pdf, row, url } = await import(T('pilot/lib/fixtures.ts'));
const { appServer } = await import(T('pilot/suite/context.mjs'));
const { vpath } = await import(T('pilot/lib/client.mjs'));
const { launch, newPage, sleep } = await import(T('pilot/lib/cdp.mjs'));
const { unzip } = await import(join(ROOT, 'scripts/parity/lib/exports.mjs'));
const { page, withBusyStore } = await import(T('bundles/lib.mjs'));
const PART = process.env.PART ?? 'server';
const BUILD = join(ROOT, 'build');
const base = '/home/vaper/.cache/lane03-tmp';
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(join(base, 'run-'));
const out = {};
const BULK_ITEMS = 40, BULK_FILES = 100;
const bulkPath = (i, j) => `BULK FOLDER WITH A LONG SYNTHETIC NAME/SUBFOLDER ${i}/Synthetic item ${i} file ${j} with a long descriptive file name.pdf`;
const sc = await buildCase(join(tmp, 'case'), {
	originals: { 'INVENTED FOLDER/INVENTED BUNDLE.pdf': pdf('invented pleadings original') },
	rows: [row('PN-001', 900, 'INVENTED FOLDER/INVENTED BUNDLE.pdf', pdf('invented pleadings original').length, { bundle: 'Pleadings' })],
	edit: (r) => {
		r.SCHED.supplementary = Array.from({ length: BULK_ITEMS }, (_, i) => ({ no: i + 1, date: '', desc: `Bulk item ${i + 1}`, co: 'C', nfiles: BULK_FILES,
			files: Array.from({ length: BULK_FILES }, (_, j) => ({ fn: `file ${j}.pdf`, url: url(bulkPath(i + 1, j)), co: 'C' })) }));
		const b = r.DATA.bundles;
		b.list.push({ ...b.list[0], no: '2', name: 'Empty bundle', title: 'Empty bundle', note: '', file: '', indexFile: '', rows: [] });
	},
});
const A = appServer({ name: 'a', root: ROOT, buildDir: BUILD, port: 43100, origPort: 43101, dir: tmp });
const { startServer } = await import(T('pilot/lib/server.mjs'));
A.srv = await startServer({ root: ROOT, port: A.port, origPort: A.origPort, dataDir: A.dataDir, buildDir: BUILD, logFile: A.logFile, env: { CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z' } });
let b;
try {
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	const act = await A.c.activate(imp.importId);
	if (!imp.importId || act.status >= 400) throw new Error('import/activate failed');
	const V = vpath(sc.resultsVersion);
	const D = `${V}/bundles/discovery_tab`, C = `${V}/bundles/caselines_tab`, B = `${V}/bundles/court_bundle_tab`;
	const marks = () => A.work('SELECT count(*) n, sum(selected) s, sum(co IS NOT NULL) c FROM bundles_schedule_mark')[0];
	const post = async (action, entries) => {
		const fd = new FormData();
		for (const [k, v] of entries) fd.append(k, v);
		const body = new Response(fd);
		const bytes = new Uint8Array(await body.clone().arrayBuffer()).length;
		const t0 = performance.now();
		const r = await fetch(`${A.origin}${D}?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true', accept: 'application/json', origin: A.origin } });
		const text = await r.text();
		return { status: r.status, bytes, ms: Math.round(performance.now() - t0), json: (() => { try { JSON.parse(text); return true; } catch { return false; } })(), head: text.slice(0, 120) };
	};
	const keys = (n) => { const ks = []; for (let i = 1; i <= BULK_ITEMS && ks.length < n; i++) for (let j = 0; j < BULK_FILES && ks.length < n; j++) ks.push(['key', bulkPath(i, j)]); return ks; };

	if (PART === 'server') {
		// 1. the size of a multi-key write: Mark Copy sends every selected key in one POST
		for (const n of [500, 2000, 2400, 2600, 3000, 4000]) {
			await post('clear', []);
			out[`select_${n}`] = { ...(await post('select', [['on', '1'], ...keys(n)])), rows: marks() };
		}
		// 2. a held store lock in the middle of one multi-key write
		await post('clear', []);
		const before = marks();
		let res;
		const p = post('co', [['val', 'O'], ...keys(2000)]);
		await sleep(150);
		const { Database } = await import('bun:sqlite');
		const d = new Database(join(A.dataDir, 'work.sqlite'));
		d.exec('PRAGMA busy_timeout=0');
		let tries = 0;
		for (;;) { try { d.exec('BEGIN IMMEDIATE'); break; } catch { tries++; await sleep(1); } }
		const rowsAtLock = marks();
		const t0 = Date.now();
		res = await p;
		const left = 12500 - (Date.now() - t0); if (left > 0) await sleep(left);
		d.exec('ROLLBACK'); d.close();
		out.busy_lock = { tries, rowsAtLock };
		out.busy_mid_write = { before, response: res, after: marks() };
		// 3. traversal and absolute paths through the CaseLines link action
		const link = async (path) => { const fd = new FormData(); fd.append('path', path); const r = await fetch(`${A.origin}${C}?/link`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true', accept: 'application/json', origin: A.origin } }); return { status: r.status, body: (await r.text()).slice(0, 160) }; };
		out.link = {};
		for (const pth of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/%2e%2e/b.pdf', '.clearcase/work.sqlite', 'INVENTED FOLDER/INVENTED BUNDLE.pdf']) out.link[pth] = await link(pth);
		const html = await (await fetch(`${A.origin}${C}`)).text();
		out.link_render = { servedLinks: (html.match(/href="\/v\/[^"]*\/doc\/[^"]*"/g) ?? []).length, notServed: (html.match(/not in the verified index; not served/g) ?? []).length, rows: A.work("SELECT count(*) n FROM register_row WHERE store = 'caselines-links'")[0].n };
		// 4. response headers of the three views and a form action
		out.headers = {};
		for (const [k, u] of [['discovery', D], ['caselines', C], ['court', B]]) { const r = await fetch(`${A.origin}${u}`); out.headers[k] = { status: r.status, type: r.headers.get('content-type'), csp: !!r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') }; }
	} else {
		b = await launch({ profileRoot: join(tmp, 'profile') });
		const p = await page(b, A.origin);
		// A. one click, one download, after many visits, mode switches and sub-view toggles
		await p.go(D, 'discovery_tab');
		await p.downloads();
		for (let k = 0; k < 3; k++) {
			for (const m of ['supplementary', 'discovery']) { await p.click(`#main .ds-switch button[data-mode="${m}"]`); await p.idle(); }
			await p.click('#ds-build'); await p.waitFor(`document.getElementById('ds-bundle')`); await p.click('#ds-back'); await p.waitFor(`document.getElementById('ds-list')`);
			await p.click('#nav-caselines_tab'); await p.waitFor(`document.querySelector('main[data-ready="caselines_tab"][data-hydrated]')`);
			await p.click('#nav-discovery_tab'); await p.waitFor(`document.querySelector('main[data-ready="discovery_tab"][data-hydrated]')`);
		}
		await p.click('#ds-cover-dl'); await sleep(400);
		const cover = await p.downloads();
		await p.click('#ds-build'); await p.waitFor(`document.getElementById('ds-bundle')`);
		await p.click('#ds-dlindex'); await sleep(400);
		const idx = await p.downloads();
		await p.click('#ds-back');
		out.oneClick = { cover: cover.map((d) => d.name), index: idx.map((d) => d.name), emptyIndex: idx[0] ? /\(0 documents\)/.test(Buffer.from(idx[0].base64, 'base64').toString()) : null };
		// B. Court Bundle: tab and bundle switches, then one press of each Word control; header with a control character
		await p.go(B, 'court_bundle_tab');
		await p.type('#cbh_claimant', 'Synthetic party\u000bsecond line');
		await p.click('#cb-save'); await p.idle(); await sleep(300);
		const stored = A.work("SELECT fields FROM register_row WHERE store = 'bundle-header'").map((r) => JSON.stringify(r.fields).includes('\\u000b'));
		for (let k = 0; k < 2; k++) {
			await p.click('#cb-list tbody tr:first-child button'); await p.waitFor(`document.getElementById('cb-index')`);
			for (const t of ['items', 'view', 'index']) { await p.click(`#cb-tab-${t}`); await sleep(150); }
			await p.click('#cb-all'); await p.waitFor(`document.getElementById('cb-list')`);
		}
		await p.downloads();
		await p.click('#cb-word-all'); await sleep(400);
		const all = await p.downloads();
		await p.click('#cb-list tbody tr:first-child button'); await p.waitFor(`document.getElementById('cb-index')`);
		await p.click('#cb-word'); await sleep(400);
		const one = await p.downloads();
		await p.click('#cb-all'); await p.waitFor(`document.getElementById('cb-list')`);
		await p.click('#cb-list tbody tr:nth-child(2) button'); await p.waitFor(`document.getElementById('cb-index')`);
		await p.click('#cb-word'); await sleep(400);
		const empty = await p.downloads();
		const wellFormed = async (d) => { const xml = new TextDecoder().decode(unzip(new Uint8Array(Buffer.from(d.base64, 'base64'))).get('word/document.xml')); return p.evaluate(`!new DOMParser().parseFromString(${JSON.stringify(xml)}, 'application/xml').querySelector('parsererror')`); };
		out.court = { storedHasVT: stored, all: all.map((d) => d.name), one: one.map((d) => d.name), allWellFormed: all[0] ? await wellFormed(all[0]) : null, oneWellFormed: one[0] ? await wellFormed(one[0]) : null, emptyBundle: empty.map((d) => d.name), emptyWellFormed: empty[0] ? await wellFormed(empty[0]) : null };
		// C. CaseLines session uploads: the Download link is a blob URL of the file's own type, on the app origin
		await p.go(C, 'caselines_tab');
		const htmlFile = join(tmp, 'synthetic-upload.html');
		writeFileSync(htmlFile, `<!doctype html><title>x</title><script>document.title = 'RAN ' + location.origin; fetch('/api/health').then((r) => r.json()).then((j) => { document.title += ' health=' + (j && typeof j === 'object'); });</script>`);
		const { root } = await p.s('DOM.getDocument');
		const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cl-file' });
		await p.s('DOM.setFileInputFiles', { nodeId, files: [htmlFile] });
		await p.waitFor(`[...document.querySelectorAll('#cl-docs li')].some((l) => l.textContent.includes('synthetic-upload.html'))`);
		const a = await p.evaluate(`(() => { const l = [...document.querySelectorAll('#cl-docs li')].find((x) => x.textContent.includes('synthetic-upload.html')); const a = l.querySelector('a'); return { href: a.href, download: a.getAttribute('download'), target: a.target }; })()`);
		// C1. "Open link in new tab" (same browser context): navigate a new tab to the link's href
		const t = await newPage(b);
		await t.navigate(a.href);
		await sleep(800);
		const opened = await t.evaluate(`({ title: document.title, origin: location.origin, type: document.contentType })`);
		await t.close();
		// C2. a middle click on the Download link
		const before = (await b.send('Target.getTargets')).targetInfos.filter((x) => x.type === 'page').map((x) => x.targetId);
		const box = await p.evaluate(`(() => { const l = [...document.querySelectorAll('#cl-docs li')].find((x) => x.textContent.includes('synthetic-upload.html')); const r = l.querySelector('a').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'middle', buttons: type === 'mousePressed' ? 4 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
		await sleep(1500);
		const after = (await b.send('Target.getTargets')).targetInfos.filter((x) => x.type === 'page' && !before.includes(x.targetId));
		out.upload = { anchor: { download: a.download, target: a.target, scheme: a.href.split(':')[0], sameOrigin: a.href.startsWith('blob:' + A.origin) }, openedInNewTab: opened, middleClick: after.map((x) => ({ url: x.url.split(':')[0], title: x.title })) };
		// D. a very large selection: tick 40 items of 100 files, then Mark Copy (one POST with every selected key)
		await p.go(D, 'discovery_tab');
		await p.click(`#main .ds-switch button[data-mode="supplementary"]`); await p.idle();
		for (let i = 1; i <= BULK_ITEMS; i++) { await p.click(`tr[data-item="supplementary-${i}"] td:first-child input`); }
		await p.idle();
		const selRows = marks();
		await p.click('#ds-mark-c'); await sleep(1500); await p.idle().catch(() => {});
		const err1 = await p.evaluate(`document.getElementById('ds-error')?.textContent ?? null`);
		// a later, small action after the failure
		await p.click(`tr[data-item="supplementary-1"] td:first-child input`); await sleep(800);
		const afterSmall = marks();
		await p.click('#ds-retry'); await sleep(2500);
		const err2 = await p.evaluate(`document.getElementById('ds-error')?.textContent ?? null`);
		await p.go(D, 'discovery_tab');
		const reloaded = { count: await p.text('#ds-count') };
		out.largeSelection = { selRows, err1, afterSmall, err2, afterRetry: marks(), reloaded };
		await p.close?.();
	}
} catch (e) { out.error = String(e?.stack ?? e); }
finally {
	await b?.close?.().catch?.(() => {});
	await A.srv?.stop().catch(() => {});
	writeFileSync(join(import.meta.dirname, `probe-${PART}.json`), JSON.stringify(out, null, 1));
	rmSync(tmp, { recursive: true, force: true });
	process.exit(out.error ? 1 : 0);
}
