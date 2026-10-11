#!/usr/bin/env bun
// Offline browser suite of the bundle views (GRS-19): Discovery Schedule, CaseLines and Court Bundle, on synthetic
// cases built with the pilot's converter (tests/e2e/pilot/lib/fixtures.ts). `test:e2e` runs it in its own network
// namespace and reads its exit code; it writes $CLEARCASE_E2E_OUT/bundles/summary.json ({scenarios: [{id, view,
// pass}]}) and one result file. Failures are caused from outside the app: a held work.sqlite write lock, a stopped
// server, SIGKILL and graceful restarts. Ports 43100-43101 (this namespace only).
process.env.CANARY_PORT ??= '43299';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { recorder, outDir } = await import('../pilot/lib/record.mjs');
const { launch, newPage, sleep } = await import('../pilot/lib/cdp.mjs');
const { buildCase, putOriginal, pdf, row, url } = await import('../pilot/lib/fixtures.ts');
const { appServer } = await import('../pilot/suite/context.mjs');
const { vpath } = await import('../pilot/lib/client.mjs');
const { docxText, pdfText, unzip } = await import('../../../scripts/parity/lib/exports.mjs');
const { makePdf, SET } = await import('../../bundles/fixtures/make-pdfs.mjs');
const { holdStore, page, text, titleAndFocus, usableControls, withBusyStore } = await import('./lib.mjs');

const ROOT = resolve(process.env.E2E_ROOT ?? join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const R = recorder('bundles-suite', { root: ROOT, build: BUILD });
const scenarios = [];
const S = async (id, view, title, fn) => {
	const before = R.results.length;
	await R.step(id, title, fn);
	scenarios.push({ id, view, pass: R.results[before]?.status === 'PASS' });
};
const finish = () => {
	const dir = join(outDir(), 'bundles');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'summary.json'), JSON.stringify({ scenarios }, null, 1));
	const ok = R.finish() && scenarios.length > 0 && scenarios.every((s) => s.pass);
	return ok;
};

const offline = await proveOffline();
if (!offline.pass) { scenarios.push({ id: 'NET-OFFLINE', view: 'discovery_tab', pass: false }); R.rec('NET-OFFLINE', 'the run is offline', 'FAIL', offline); process.exit(finish() ? 0 : 1); }

const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-bundles-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const enc = (s) => new TextEncoder().encode(s);

// The synthetic case: schedules with an unindexed file, an item without files and a two-file item; a second bundle
// whose PDFs are not indexed and a blank description; an indexed CaseLines original with one page without text.
const sc = await buildCase(join(tmp, 'case-a'), {
	originals: { 'INVENTED FOLDER/INVENTED BUNDLE.pdf': pdf('invented pleadings original') },
	rows: [row('PN-001', 900, 'INVENTED FOLDER/INVENTED BUNDLE.pdf', pdf('invented pleadings original').length, { bundle: 'Pleadings' })],
	edit: (r) => {
		r.SCHED.discovery.push(
			{ no: 2, date: '04/02/2001', desc: 'Invented two-file item', co: 'C', nfiles: 2, files: [{ fn: 'OD-002 Invoice 1001.pdf', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf'), co: 'C' }, { fn: 'Not indexed.pdf', url: url('NOT INDEXED/Not indexed.pdf'), co: 'C' }] },
			{ no: 3, date: '', desc: 'Invented unmatched item', co: 'C', nfiles: 0, files: [] },
		);
		r.CASELINES.index = [[1, 'Invented page one about the court'], [2, '   '], [3, 'Court again and court once more']];
		r.CASELINES.pages = 3;
		const b = r.DATA.bundles;
		b.list.push({ ...b.list[0], no: '2', name: 'Bundle B', title: 'Bundle B', note: '', file: url('NOT INDEXED/Bundle B.pdf'), indexFile: url('NOT INDEXED/Index B.pdf'),
			rows: [{ key: 'OD-1', n: 1, desc: '', date: '', from: 1, to: 3, pages: 3, parts: [{ url: url('NOT INDEXED/part.pdf'), name: '(1) Part.pdf', rel: 'part.pdf', from: 2, to: 4 }] }] });
	},
});
const A = appServer({ name: 'a', root: ROOT, buildDir: BUILD, port: 43100, origPort: 43101, dir: tmp });
A.start = ((start) => () => start())(A.start);
let b;
const env = { CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z' };
const startA = async () => { const { startServer } = await import('../pilot/lib/server.mjs'); A.srv = await startServer({ root: ROOT, port: A.port, origPort: A.origPort, dataDir: A.dataDir, buildDir: BUILD, logFile: A.logFile, env }); return A.srv; };
try {
	await startA();
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	const act = await A.c.activate(imp.importId);
	if (!imp.importId || act.status >= 400) throw new Error(`import/activate failed: ${JSON.stringify({ imp: imp.status, act: act.status })}`);
	const rv = sc.resultsVersion;
	const V = vpath(rv);
	b = await launch({ profileRoot: join(tmp, 'profile') });
	const p = await page(b, A.origin);
	// BUNDLES_SHOT_DIR: save synthetic screenshots of the product-visible changes (for the report; synthetic data only)
	const shot = async (name) => { const dir = process.env.BUNDLES_SHOT_DIR; if (!dir) return; mkdirSync(dir, { recursive: true }); const { data } = await p.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64')); };
	const D = `${V}/bundles/discovery_tab`, C = `${V}/bundles/caselines_tab`, B = `${V}/bundles/court_bundle_tab`;
	const marks = () => A.work('SELECT case_id, locator, selected, co FROM bundles_schedule_mark ORDER BY locator');
	const chip = (fn) => `#ds-list .ds-chip[data-key$=${JSON.stringify('/' + fn)}] input[type=checkbox]`;
	// CC-09 builder (GRS-19): synthetic PDFs from the committed generator (tests/bundles/fixtures/make-pdfs.mjs)
	const PDFS = join(tmp, 'build-pdfs');
	mkdirSync(PDFS, { recursive: true });
	for (const [n, o] of Object.entries(SET)) writeFileSync(join(PDFS, n), makePdf(o));
	const pick = async (pp, names, dir = PDFS) => { const { root } = await pp.s('DOM.getDocument'); const { nodeId } = await pp.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cbbfile' }); await pp.s('DOM.setFileInputFiles', { nodeId, files: names.map((n) => join(dir, n)) }); };
	const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
	const pdfPages = async (buf) => { const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const t = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 }); const d = await t.promise; const n = d.numPages; await t.destroy(); return n; };

	// ---- Discovery Schedule -----------------------------------------------------------------------------------
	await S('DS-TITLE', 'discovery_tab', 'Discovery Schedule: document title, heading, focus on the heading after sidebar navigation', () => titleAndFocus(p, V, 'discovery_tab', 'Discovery Schedule'));
	await S('DS-SOURCE', 'discovery_tab', 'scenario 1: the schedule matches its source rows, order and counts; an unindexed file is not served; an item without files is marked (BA-10)', async () => {
		await p.go(D, 'discovery_tab');
		await shot('discovery-not-served');
		const r = await p.evaluate(`({ items: [...document.querySelectorAll('#ds-list tr[data-item]')].map((t) => t.querySelector('.ds-no').textContent.trim()), info: document.getElementById('ds-info').textContent.replace(/\\s+/g, ' ').trim(), notServed: document.querySelectorAll('#ds-list .not-served').length, none: document.querySelector('#ds-list .ds-none')?.textContent.trim(), unmatched: document.getElementById('ds-missing').closest('label').textContent.trim(), links: [...document.querySelectorAll('#ds-list .ds-chip a:not(.dl)')].map((a) => a.getAttribute('href')), dl: [...document.querySelectorAll('#ds-list .ds-chip a.dl')].map((a) => [a.textContent, a.getAttribute('href'), a.hasAttribute('download')]) })`);
		return { pass: r.items.join(',') === '1.,2.,3.' && /3 items · 3 files linked · 1 not in the verified index · uncertified$/.test(r.info) && r.notServed === 1 && r.none === 'No separate document on file — see coverage note' && r.unmatched === 'Only unmatched (1)' && r.links.every((h) => h.startsWith(`${V}/doc/`)) && r.dl.length > 0 && r.dl.every(([t, h, d]) => t === 'Download' && h.startsWith(`${A.orig}/o/`) && h.endsWith('&download=1') && d), evidence: r };
	});
	await S('DS-ONE-CLICK', 'discovery_tab', 'S-discovery_tab-1: after three schedule switches one press of Download cover page gives exactly one download, named from view-content', async () => {
		await p.go(D, 'discovery_tab');
		await p.downloads();
		for (const m of ['supplementary', 'discovery', 'supplementary']) { await p.click(`#main .ds-switch button[data-mode="${m}"]`); await p.idle(); }
		await p.click('#ds-cover-dl');
		await sleep(300);
		const got = await p.downloads();
		await p.click('#main .ds-switch button[data-mode="discovery"]');
		await p.idle();
		return { pass: got.length === 1 && got[0].name === 'Invented supplementary affidavit (cover).html' && /SCHEDULE ONE A/.test(text(got[0])), evidence: { n: got.length, name: got[0]?.name } };
	});
	await S('DS-INCOMPLETE', 'discovery_tab', 'scenarios 2 and 10: an incomplete item and an incomplete selection stay visibly incomplete in the cover page and the bundle index', async () => {
		await p.go(D, 'discovery_tab');
		await p.click(chip('OD-002 Invoice 1001.pdf'));
		await p.click(chip('Not indexed.pdf'));
		await p.idle();
		await p.click('#ds-cover-dl');
		await sleep(200);
		const cover = text((await p.downloads())[0]);
		await p.click(chip('Not indexed.pdf'));
		await p.idle();
		await p.click('#ds-build');
		await p.waitFor(`document.getElementById('ds-bundle')`);
		const warn = await p.text('#ds-incomplete');
		await shot('discovery-incomplete-selection');
		await p.click('#ds-dlindex');
		await sleep(200);
		const idx = text((await p.downloads())[0]);
		await p.click('#ds-empty');
		await p.idle();
		await p.click('#ds-back');
		return { pass: /Invented unmatched item \[No separate document on file — see coverage note\]/.test(cover) && /\(uncertified\)/.test(await p.text('#ds-cover-dl')) && /1 item is only partly selected/.test(warn) && /<b>INCOMPLETE SELECTION<\/b>: 1 item is only partly selected\./.test(idx), evidence: { warn } };
	});
	await S('DS-PERSIST', 'discovery_tab', 'scenarios 3 and 4: selection across schedules in v5 order, Copy/Original marks, and the selection reloaded; one row per locator', async () => {
		await p.go(D, 'discovery_tab');
		await p.click(chip('OD-002 Invoice 1001.pdf'));
		await p.click(chip('OD-001 Supply agreement.pdf'));
		await p.click('#main .ds-switch button[data-mode="supplementary"]');
		await p.click(chip('SD-001 Statement.pdf'));
		await p.click('#ds-mark-o');
		await p.idle();
		await p.go(D, 'discovery_tab');
		const mode = await p.evaluate(`document.querySelector('#main .ds-switch button.on')?.dataset.mode`);
		const count = await p.text('#ds-count');
		await p.click('#ds-build');
		await p.waitFor(`document.getElementById('ds-bundle-table')`);
		const order = await p.evaluate(`[...document.querySelectorAll('#ds-bundle-table tbody tr')].map((r) => [...r.cells].slice(0, 6).map((c) => c.querySelector('.fn')?.textContent ?? c.textContent.trim()).join('|'))`);
		await p.click('#ds-back');
		const rows = marks();
		return { pass: mode === 'supplementary' && count === '3' && order.join('\n') === ['1|Discovery Affidavit — First Schedule|1.|OD-001 Supply agreement.pdf|03/02/2001|O', '2|Discovery Affidavit — First Schedule|2.|OD-002 Invoice 1001.pdf|04/02/2001|O', '3|Supplementary — First Schedule A|1.|SD-001 Statement.pdf||O'].join('\n') && rows.length === 3 && rows.every((x) => x.selected === 1 && x.co === 'O'), evidence: { mode, count, order, rows: rows.length } };
	});
	await S('DS-COVER-CO', 'discovery_tab', 'S-discovery_tab-2: the cover page follows the marks per item (mixed gives C&O)', async () => {
		await p.go(D, 'discovery_tab');
		if ((await p.evaluate(`document.querySelector('#main .ds-switch button.on')?.dataset.mode`)) !== 'discovery') { await p.click('#main .ds-switch button[data-mode="discovery"]'); await p.idle(); }
		await p.evaluate(`document.querySelector(${JSON.stringify(chip('Not indexed.pdf'))}).closest('.ds-chip').querySelector('button[aria-label=Copy]').setAttribute('data-t', '1')`);
		await p.click('[data-t="1"]');
		await p.idle();
		await p.downloads();
		await p.click('#ds-cover-dl');
		await sleep(200);
		const cover = text((await p.downloads())[0]);
		return { pass: /<td class="n">2\.<\/td><td>Invented two-file item<\/td><td class="d">04\/02\/2001<\/td><td class="co">C&amp;O<\/td>/.test(cover) && /<td class="n">1\.<\/td><td>Invented<\/td><td class="d">03\/02\/2001<\/td><td class="co">O<\/td>/.test(cover) };
	});
	await S('DS-BUSY', 'discovery_tab', 'failed write: a held store lock (>12 s) shows the error, keeps the ticked file and writes nothing; after release one retry saves exactly one row', async () => {
		await p.go(D, 'discovery_tab');
		await p.click('#ds-clear');
		await p.idle();
		const before = marks().filter((x) => x.selected === 1).length;
		let during;
		await withBusyStore(A.dataDir, 12500, async () => {
			await p.click(chip('OD-001 Supply agreement.pdf'));
			await p.waitFor(`document.getElementById('ds-error')`, 20000);
			during = { error: await p.text('#ds-error'), checked: await p.evaluate(`document.querySelector(${JSON.stringify(chip('OD-001 Supply agreement.pdf'))}).checked`), count: await p.text('#ds-count'), rows: marks().filter((x) => x.selected === 1).length };
		});
		await p.click('#ds-retry');
		await p.idle();
		const after = marks().filter((x) => x.selected === 1 && x.locator.endsWith('OD-001 Supply agreement.pdf'));
		return { pass: before === 0 && /busy/.test(during.error) && during.checked && during.count === '1' && during.rows === 0 && after.length === 1 && !(await p.evaluate(`!!document.getElementById('ds-error')`)), evidence: { before, during, after: after.length } };
	});
	await S('DS-TRANSPORT', 'discovery_tab', 'failed write: with the server stopped the error shows and the selection is kept; after a restart one retry saves exactly one row', async () => {
		await p.go(D, 'discovery_tab');
		await A.stop();
		await p.click(chip('OD-002 Invoice 1001.pdf'));
		await p.waitFor(`document.getElementById('ds-error')`, 20000);
		const during = { error: await p.text('#ds-error'), checked: await p.evaluate(`document.querySelector(${JSON.stringify(chip('OD-002 Invoice 1001.pdf'))}).checked`) };
		await startA();
		const rowsBefore = marks().filter((x) => x.selected === 1 && x.locator.endsWith('OD-002 Invoice 1001.pdf')).length;
		await p.click('#ds-retry');
		await p.idle();
		const rows = marks().filter((x) => x.selected === 1 && x.locator.endsWith('OD-002 Invoice 1001.pdf')).length;
		return { pass: /could not be reached/.test(during.error) && during.checked && rowsBefore === 0 && rows === 1, evidence: { during, rowsBefore, rows } };
	});

	// ---- CaseLines ----------------------------------------------------------------------------------------------
	await S('CL-TITLE', 'caselines_tab', 'CaseLines: document title, heading, focus on the heading after sidebar navigation', () => titleAndFocus(p, V, 'caselines_tab', 'CaseLines'));
	await S('CL-SEARCH', 'caselines_tab', 'scenarios 6 and 7: search the page-text index (v5 counts and order) and follow a page reference to the document page at that page', async () => {
		await p.go(C, 'caselines_tab');
		await p.type('#cl-q', 'court');
		await p.key('Enter');
		await p.waitFor(`document.getElementById('cl-results')?.dataset.q === 'court'`);
		const r = await p.evaluate(`({ summary: document.getElementById('cl-summary')?.textContent.replace(/\\s+/g, ' ').trim(), hits: [...document.querySelectorAll('.cl-hit')].map((a) => a.textContent.replace(/\\s+/g, ' ').trim()), href: document.querySelector('.cl-hit')?.getAttribute('href') })`);
		await p.click('.cl-hit[data-p="3"]');
		await p.waitFor(`location.pathname.includes('/doc/')`);
		const at = await p.evaluate(`location.pathname + location.search`);
		await p.go(C, 'caselines_tab');
		await p.type('#cl-pg', '2');
		await p.click('#cl-goto');
		await p.waitFor(`location.pathname.includes('/doc/')`);
		const at2 = await p.evaluate(`location.search`);
		return { pass: r.summary === '2 page(s) · 3 occurrence(s) of “court”. Click a result to open the bundle at that page.' && r.hits.join('|') === 'p.1Invented page one about the court|p.3Court again and court once more (2×)' && at === `${V}/doc/PN-001?page=3` && at2 === '?page=2', evidence: { r, at, at2 } };
	});
	await S('CL-MISSING-TEXT', 'caselines_tab', 'scenario 8 and BA-08: the page without text is disclosed with counts derived from the index', async () => {
		await p.go(C, 'caselines_tab');
		const t = await p.text('#cl-coverage');
		await shot('caselines-coverage');
		return { pass: t === 'Search covers the page-text index only: 3 pages indexed of 3, 1 without text (p.2). Words on pages without text, and in images, are not found.', evidence: { t } };
	});
	await S('CL-LARGE', 'caselines_tab', 'scenario 9: the CaseLines original resolves by exact path and opens through the document page (two clicks, the isolated viewer at the page)', async () => {
		await p.go(C, 'caselines_tab');
		const open = await p.evaluate(`document.getElementById('cl-open')?.getAttribute('href')`);
		await p.go(`${V}/doc/PN-001?page=2`);
		await p.waitFor(`document.getElementById('original-state')`);
		const r = await p.evaluate(`({ route: document.querySelector('#original-state .route')?.dataset.route, open: document.getElementById('open-original')?.textContent.trim(), href: document.getElementById('open-original')?.getAttribute('href') ?? '' })`);
		return { pass: open === `${V}/doc/PN-001` && r.route === 'direct' && r.open === 'Open at page 2' && /#page=2$/.test(r.href), evidence: { open, route: r.route, label: r.open } };
	});
	await S('CL-LINKS', 'caselines_tab', 'linked files persist (exact path only), a busy store keeps the typed path, uploads are download-only and never open in the app (S-caselines_tab-1)', async () => {
		await p.go(C, 'caselines_tab');
		await p.type('#cl-path', '/DISCOVERY A/OD-003 Scan.pdf');
		let during;
		await withBusyStore(A.dataDir, 12500, async () => {
			await p.click('#cl-link');
			await p.waitFor(`document.getElementById('cl-error')`, 20000);
			during = { value: await p.evaluate(`document.getElementById('cl-path').value`), rows: A.work("SELECT count(*) n FROM register_row WHERE store = 'caselines-links'")[0].n };
		});
		await p.click('#cl-link');
		await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length === 1`);
		await p.type('#cl-path', 'Not there/x.pdf');
		await p.click('#cl-link');
		await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length === 2`);
		await p.go(C, 'caselines_tab');
		const list = await p.evaluate(`[...document.querySelectorAll('#cl-docs li[data-row]')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
		const file = join(tmp, 'upload.txt');
		writeFileSync(file, 'invented upload');
		const { root } = await p.s('DOM.getDocument');
		const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cl-file' });
		await p.s('DOM.setFileInputFiles', { nodeId, files: [file] });
		await p.waitFor(`[...document.querySelectorAll('#cl-docs li')].some((l) => l.textContent.includes('upload.txt'))`);
		await shot('caselines-upload-download-only');
		const up = await p.evaluate(`(() => { const l = [...document.querySelectorAll('#cl-docs li')].find((x) => x.textContent.includes('upload.txt')); return { links: [...l.querySelectorAll('a')].map((a) => [a.textContent.trim(), a.hasAttribute('download')]), path: location.pathname }; })()`);
		const rows = A.work("SELECT count(*) n FROM register_row WHERE store = 'caselines-links'")[0].n;
		return { pass: during.value === '/DISCOVERY A/OD-003 Scan.pdf' && during.rows === 0 && rows === 2 && /^📄 OD-003 Scan\.pdf \(linked\)OpenDownloadRemove$/.test(list[0]) && /x\.pdf \(linked\)not in the verified index; not servedRemove$/.test(list[1]) && JSON.stringify(up.links) === '[["Download",true]]' && up.path === C, evidence: { during, list, up, rows } };
	});

	// ---- Court Bundle -----------------------------------------------------------------------------------------
	await S('CB-TITLE', 'court_bundle_tab', 'Court Bundle: document title, heading, focus on the heading after sidebar navigation', () => titleAndFocus(p, V, 'court_bundle_tab', 'Court Bundle'));
	await S('CB-LIST', 'court_bundle_tab', 'list view: counts, statuses, unindexed bundle PDFs named but not served; Build a bundle opens the builder', async () => {
		await p.go(B, 'court_bundle_tab');
		await shot('court-bundle-list');
		const rows = await p.evaluate(`[...document.querySelectorAll('#cb-list tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join('|'))`);
		await p.click('#cb-build');
		await p.waitFor(`document.getElementById('cbbfile')`);
		const state = await p.text('#cb-builder-h');
		return { pass: rows.length === 2 && /^1\|Bundle AInvented\|1\|2\|complete\|Open Bundle PDF Index PDF Word$/.test(rows[0]) && /^2\|Bundle B\|1\|2\|complete\|Open Bundle PDF \(not in the verified index; not served\) Index PDF \(not in the verified index; not served\) Word$/.test(rows[1]) && state === 'Build a bundle', evidence: { rows, state } };
	});
	await S('CB-HEADER', 'court_bundle_tab', 'header: a busy store keeps all eight typed fields and writes nothing; retry saves one row; restore and clear; the index and Word export use it (scenario 5)', async () => {
		await p.go(B, 'court_bundle_tab');
		const vals = { court: 'SYN COURT', judge: 'SYN DIVISION', intro: 'Between:', caseNo: '7/2001', claimant: 'SYN ONE\nLINE TWO', claimantRole: 'APPLICANT', defendant: 'SYN TWO', defendantRole: 'RESPONDENT' };
		for (const [k, v] of Object.entries(vals)) await p.evaluate(`(() => { const e = document.getElementById('cbh_${k}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		let during;
		await withBusyStore(A.dataDir, 12500, async () => {
			await p.click('#cb-save');
			await p.waitFor(`document.getElementById('cb-error')`, 20000);
			during = { kept: await p.evaluate(`${JSON.stringify(Object.keys(vals))}.every((k) => document.getElementById('cbh_' + k).value === ${JSON.stringify(vals)}[k])`), rows: A.work("SELECT count(*) n FROM register_row WHERE store = 'bundle-header'")[0].n };
		});
		// the page never shows idle while the saved fields still count as changed (a reload then would warn for nothing)
		await p.evaluate(`(() => { const m = document.getElementById('main'); window.__cbIdleUnsaved = []; new MutationObserver(() => { const u = document.getElementById('cb-unsaved')?.textContent ?? ''; if (m.dataset.busy === '0' && u) window.__cbIdleUnsaved.push(u); }).observe(m, { attributes: true, childList: true, subtree: true, characterData: true }); })()`);
		await p.click('#cb-save');
		await p.waitFor(`!document.getElementById('cb-error') && document.querySelector('#main').dataset.busy === '0'`, 30000);
		const idleUnsaved = await p.evaluate(`window.__cbIdleUnsaved`);
		for (let i = 0; i < 100 && !A.work("SELECT count(*) n FROM register_row WHERE store = 'bundle-header'")[0].n; i++) await sleep(50);
		const saved = A.work("SELECT fields FROM register_row WHERE store = 'bundle-header'");
		await p.go(`${B}?b=2&tab=index`, 'court_bundle_tab');
		const head = await p.evaluate(`[...document.querySelectorAll('#cbindexdoc > p')].map((x) => x.textContent.trim()).filter((x) => x && x !== '\\u00a0')`);
		const idx = await p.evaluate(`[...document.querySelectorAll('#cbindexdoc tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()).join('|'))`);
		await p.downloads();
		await p.click('#cb-word');
		await sleep(300);
		const doc = (await p.downloads())[0];
		const dtext = doc ? docxText(Buffer.from(doc.base64, 'base64')) : '';
		await p.go(B, 'court_bundle_tab');
		await p.click('#cb-clear');
		await p.waitFor(`document.getElementById('cbh_court').value === '' && !!document.querySelector('#cb-header .meta b')`, 30000);
		const cleared = await p.evaluate(`document.getElementById('cbh_court').value + '|' + document.querySelector('#cb-header .meta b')?.textContent`);
		await p.click('#cb-restore');
		await p.waitFor(`document.getElementById('cbh_court').value !== ''`, 30000);
		const restored = await p.evaluate(`document.getElementById('cbh_court').value`);
		const left = A.work("SELECT count(*) n FROM register_row WHERE store = 'bundle-header'")[0].n;
		return {
			pass: idleUnsaved.length === 0 && during.kept && during.rows === 0 && saved.length === 1 && JSON.parse(saved[0].fields).caseNo === '7/2001' && head.join('|') === 'SYN COURT|SYN DIVISION|CASE NUMBER: 7/2001|Between:|SYN ONE\nLINE TWOAPPLICANT|and|SYN TWORESPONDENT|INDEX|Bundle B'
				&& idx.join('\n') === '1.|[DESCRIPTION TO BE COMPLETED]|001 – 003' && doc?.name === 'Index_2_Bundle_B.docx' && dtext.split('\n').join('|') === 'SYN COURT|SYN DIVISION|CASE NUMBER: 7/2001|Between:|SYN ONE APPLICANT|LINE TWO|and|SYN TWO RESPONDENT|INDEX|Bundle B|1.|[DESCRIPTION TO BE COMPLETED]|001 – 003'
				&& cleared === '|8 fields blank — placeholders will be used.' && restored === 'Invented court' && left === 0,
			evidence: { idleUnsaved, during, head, idx, name: doc?.name, dtext, cleared, restored, left },
		};
	});
	await S('CB-ITEMS', 'court_bundle_tab', 'items tab: a part resolves by exact path at its page; unindexed parts and bundles are named but not served', async () => {
		await p.go(`${B}?b=1&tab=items`, 'court_bundle_tab');
		const a = await p.evaluate(`[...document.querySelectorAll('#cb-items tbody tr td:nth-child(4) a')].map((x) => x.getAttribute('href'))`);
		await p.go(`${B}?b=2&tab=items`, 'court_bundle_tab');
		const t = await p.evaluate(`document.querySelector('#cb-items tbody tr td:nth-child(4)').textContent.replace(/\\s+/g, ' ').trim() + '|' + document.querySelector('#cb-items tbody tr td:last-child').textContent.replace(/\\s+/g, ' ').trim()`);
		return { pass: a.length === 1 && a[0].startsWith(`${V}/doc/`) && t === 'Part (not in the verified index; not served) pp 2–4 of source|Open item (not in the verified index; not served)', evidence: { a, t } };
	});
	await S('CB-RESTART', 'court_bundle_tab', 'restarts: after a SIGKILL restart and a graceful restart every saved bundle-view row is unchanged (by id and fields)', async () => {
		await p.go(B, 'court_bundle_tab');
		await p.evaluate(`(() => { const e = document.getElementById('cbh_caseNo'); e.value = '9/2001'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await p.click('#cb-save');
		for (let i = 0; i < 100 && !A.work("SELECT fields FROM register_row WHERE store = 'bundle-header'").some((r) => JSON.parse(r.fields).caseNo === '9/2001'); i++) await sleep(50);
		const snap = () => ({ marks: A.work('SELECT * FROM bundles_schedule_mark ORDER BY case_id, locator'), regs: A.work("SELECT row_id, store, fields FROM register_row WHERE store IN ('bundle-header', 'caselines-links', 'discovery-mode') ORDER BY row_id") });
		const s0 = JSON.stringify(snap());
		await A.srv.stop('SIGKILL');
		A.srv = null;
		await startA();
		const s1 = JSON.stringify(snap());
		await A.stop();
		await startA();
		const s2 = JSON.stringify(snap());
		await p.go(B, 'court_bundle_tab');
		const shown = await p.evaluate(`document.getElementById('cbh_caseNo').value`);
		return { pass: s0 === s1 && s1 === s2 && JSON.parse(s0).regs.length >= 3 && JSON.parse(s0).marks.length >= 1 && shown === '9/2001', evidence: { rows: JSON.parse(s0).regs.length + JSON.parse(s0).marks.length, shown } };
	});

	// ---- CC-09-r2 regressions ---------------------------------------------------------------------------------
	const J = JSON.stringify;
	const setVal = (pp, id, v) => pp.evaluate(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	const val = (pp, id) => pp.evaluate(`document.getElementById(${J(id)}).value`);
	const storedHeader = () => { const r = A.work("SELECT fields FROM register_row WHERE store = 'bundle-header'"); return r.length ? JSON.parse(r[0].fields) : null; };
	const idleBusy = (pp, t = 30000) => pp.waitFor(`document.querySelector('#main')?.dataset.busy === '0'`, t);
	const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
	const safeHeaders = (h) => /^attachment/.test(h['content-disposition'] ?? '') && h['x-content-type-options'] === 'nosniff' && /(^|;)\s*sandbox/.test(h['content-security-policy'] ?? '');

	await S('CL-UPLOAD-SAFE', 'caselines_tab', 'D1: a file added for the session (HTML, SVG with a script, HTML named .pdf), opened through its link in a new tab, never runs on the app origin: no title change, no console, it downloads', async () => {
		await p.go(C, 'caselines_tab');
		const RUN = "<script>document.title = 'RAN ' + location.origin; console.log('RAN ' + location.origin)</script>";
		const files = { 'synthetic-upload.html': `<!doctype html><title>x</title>${RUN}`, 'synthetic-upload.svg': `<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = 'RAN ' + location.origin</script></svg>`, 'synthetic-upload.pdf': `<!doctype html><title>x</title>${RUN}` };
		for (const [n, c] of Object.entries(files)) writeFileSync(join(tmp, n), c);
		const { root } = await p.s('DOM.getDocument');
		const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cl-file' });
		await p.s('DOM.setFileInputFiles', { nodeId, files: Object.keys(files).map((n) => join(tmp, n)) });
		await p.waitFor(`${J(Object.keys(files))}.every((n) => [...document.querySelectorAll('#cl-docs li')].some((l) => l.textContent.includes(n)))`);
		const out = [];
		for (const n of Object.keys(files)) {
			const a = await p.evaluate(`(() => { const l = [...document.querySelectorAll('#cl-docs li')].find((x) => x.textContent.includes(${J(n)})); const a = l.querySelector('a'); return { href: a.href, download: a.getAttribute('download'), text: a.textContent.trim() }; })()`);
			const mk = b.mark();
			const t = await newPage(b);
			await t.navigate(a.href, { timeout: 5000 });
			await sleep(1000);
			const st = await t.evaluate(`({ title: document.title, url: location.href, scripts: document.scripts.length })`).catch((e) => ({ error: String(e).slice(0, 200) }));
			await t.close();
			const ev = b.since(mk);
			out.push({ n, scheme: a.href.split(':')[0], download: a.download, text: a.text, st, downloads: ev.downloads.length, ran: ev.titles.some((x) => /^RAN/.test(x.title)) || /^RAN/.test(st.title ?? ''), console: ev.console.filter((c) => /RAN/.test(c.text) || c.kind === 'exception').length });
		}
		return { pass: out.length === 3 && out.every((o) => o.scheme === 'blob' && o.download === o.n && o.text === 'Download' && !o.ran && o.console === 0 && (o.downloads >= 1 || o.st.url === 'about:blank') && !o.st.scripts), evidence: out };
	});
	await S('CL-DOWNLOAD', 'caselines_tab', 'D13 and D1: "Download" downloads the original through the originals site (attachment, nosniff, a sandbox CSP); "Open" opens the document page', async () => {
		await p.go(C, 'caselines_tab');
		const r = await p.evaluate(`({ open: document.getElementById('cl-open')?.getAttribute('href'), dl: document.getElementById('cl-download')?.getAttribute('href'), dlAttr: document.getElementById('cl-download')?.hasAttribute('download'), linked: [...document.querySelectorAll('#cl-docs li[data-row] a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]) })`);
		const heads = [];
		for (const h of [r.dl, ...r.linked.filter(([t]) => t === 'Download').map(([, h]) => h)].filter(Boolean)) { const u = new URL(h); const res = await A.o(u.pathname + u.search); heads.push({ status: res.status, ok: safeHeaders(lower(res.headers)), type: lower(res.headers)['content-type'] }); }
		return { pass: r.open === `${V}/doc/PN-001` && r.dl?.startsWith(`${A.orig}/o/`) && r.dl.endsWith('&download=1') && r.dlAttr && heads.length >= 1 && heads.every((x) => x.status === 200 && x.ok && x.type === 'application/octet-stream'), evidence: { r: { ...r, dl: r.dl?.replace(/k=[^&]+/, 'k=…'), linked: r.linked.map(([t, h]) => [t, h.replace(/k=[^&]+/, 'k=…')]) }, heads } };
	});
	await S('CL-ERRORS', 'caselines_tab', 'D4: a failed Link keeps its own error, Retry and the typed path when a Remove succeeds afterwards; Retry links it', async () => {
		await p.go(C, 'caselines_tab');
		const n0 = await p.count('#cl-docs li[data-row]');
		await p.type('#cl-path', 'Synthetic/failing link.pdf');
		let during;
		await withBusyStore(A.dataDir, 12500, async () => { await p.click('#cl-link'); await p.waitFor(`document.getElementById('cl-error')`, 20000); during = await p.text('#cl-error'); });
		await p.evaluate(`[...document.querySelectorAll('#cl-docs li[data-row]')].at(-1).querySelector('button.rm').setAttribute('data-t', 'rm')`);
		await p.click('[data-t="rm"]');
		await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length === ${n0 - 1}`, 20000);
		const after = { error: await p.evaluate(`document.getElementById('cl-error')?.textContent ?? null`), path: await val(p, 'cl-path') };
		await p.click('#cl-retry');
		await p.waitFor(`!document.getElementById('cl-error') && document.querySelectorAll('#cl-docs li[data-row]').length === ${n0}`, 30000);
		const final = { path: await val(p, 'cl-path'), rows: A.work("SELECT fields FROM register_row WHERE store = 'caselines-links'").map((x) => JSON.parse(x.fields).path) };
		return { pass: /busy/.test(during) && /busy/.test(after.error ?? '') && after.path === 'Synthetic/failing link.pdf' && final.path === '' && final.rows.includes('Synthetic/failing link.pdf'), evidence: { during, after, final } };
	});
	await S('CL-QUERY-LIMIT', 'caselines_tab', 'D5: a search over 200 characters is refused visibly, never cut and searched', async () => {
		await p.go(`${C}?q=${'court '.repeat(40)}x`, 'caselines_tab');
		return { pass: /limited to 200 characters/.test(await p.text('#cl-too-long')) && !(await p.evaluate(`!!document.getElementById('cl-summary')`)), evidence: { t: await p.text('#cl-too-long') } };
	});
	await S('CB-INFLIGHT', 'court_bundle_tab', 'D2: text typed into another field while a header save is pending survives that save; only the submitted fields come from the store; Saving… shows', async () => {
		await p.go(B, 'court_bundle_tab');
		const judge0 = await val(p, 'cbh_judge');
		let during;
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.type('#cbh_court', 'SYN INFLIGHT COURT');
			await p.click('#cb-save');
			await p.waitFor(`document.querySelector('#main').dataset.busy === '1'`, 5000);
			await p.type('#cbh_judge', 'SYN TYPED IN FLIGHT');
			during = { saving: await p.text('#cb-saving'), aria: await p.evaluate(`document.getElementById('cb-header').getAttribute('aria-busy')`) };
		});
		await idleBusy(p);
		await sleep(300);
		const after = { court: await val(p, 'cbh_court'), judge: await val(p, 'cbh_judge'), error: await p.evaluate(`document.getElementById('cb-error')?.textContent ?? null`), unsaved: await p.text('#cb-unsaved') };
		const h = storedHeader();
		await p.click('#cb-save');
		await idleBusy(p);
		return { pass: during.saving === 'Saving…' && during.aria === 'true' && after.court === 'SYN INFLIGHT COURT' && after.judge === 'SYN TYPED IN FLIGHT' && after.error === null && after.unsaved === '1 field changed, not saved' && h?.court === 'SYN INFLIGHT COURT' && h?.judge === judge0 && storedHeader()?.judge === 'SYN TYPED IN FLIGHT', evidence: { during, after, stored: { court: h?.court, judge: h?.judge } } };
	});
	await S('CB-INFLIGHT-CLEAR', 'court_bundle_tab', 'D4: text typed while Clear all is pending survives it; the other fields clear', async () => {
		await p.go(B, 'court_bundle_tab');
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.click('#cb-clear');
			await p.waitFor(`document.querySelector('#main').dataset.busy === '1'`, 5000);
			await p.type('#cbh_caseNo', 'SYN 5/2001');
		});
		await idleBusy(p);
		await sleep(300);
		const after = { caseNo: await val(p, 'cbh_caseNo'), court: await val(p, 'cbh_court'), stored: storedHeader() };
		await p.type('#cbh_caseNo', '');
		return { pass: after.caseNo === 'SYN 5/2001' && after.court === '' && after.stored?.caseNo === '' && after.stored?.court === '', evidence: after };
	});
	await S('CB-ERRORS', 'court_bundle_tab', 'D4: Restore after a failed header save asks first; refusing keeps the typed draft and its error; Retry saves it', async () => {
		await p.go(B, 'court_bundle_tab');
		await p.type('#cbh_court', 'SYN DRAFT COURT');
		await withBusyStore(A.dataDir, 12500, async () => { await p.click('#cb-save'); await p.waitFor(`document.getElementById('cb-error')`, 20000); });
		const mk = b.mark();
		await p.click('#cb-restore');
		await sleep(600);
		const dialogs = b.since(mk).dialogs.map((d) => d.type);
		const kept = { court: await val(p, 'cbh_court'), error: await p.evaluate(`!!document.getElementById('cb-error')`), stored: storedHeader()?.court ?? null };
		await p.click('#cb-retry-header');
		await idleBusy(p);
		await sleep(200);
		return { pass: dialogs.includes('confirm') && kept.court === 'SYN DRAFT COURT' && kept.error && kept.stored !== 'SYN DRAFT COURT' && storedHeader()?.court === 'SYN DRAFT COURT' && !(await p.evaluate(`!!document.getElementById('cb-error')`)), evidence: { dialogs, kept } };
	});
	await S('CB-HEADER-INFLIGHT', 'court_bundle_tab', 'review M1: a Restore fails, Save is held in flight, and Retry and Discard are both disabled; the Restore posts nothing after the Save', async () => {
		await p.go(B, 'court_bundle_tab');
		await p.evaluate(`window.confirm = () => true`);
		await p.type('#cbh_court', 'SYN RETRY COURT');
		await withBusyStore(A.dataDir, 12500, async () => { await p.click('#cb-restore'); await p.waitFor(`document.getElementById('cb-error-restore')`, 20000); });
		let during;
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.click('#cb-save');
			await p.waitFor(`document.querySelector('#main').dataset.busy === '1'`, 5000);
			during = await p.evaluate(`({ retry: document.getElementById('cb-retry-restore')?.disabled ?? null, discard: document.getElementById('cb-discard')?.disabled ?? null })`);
			await p.click('#cb-retry-restore');
		});
		await idleBusy(p);
		await sleep(500);
		const after = { conflict: await p.evaluate(`!!document.getElementById('cb-conflict')`), court: await val(p, 'cbh_court'), stored: storedHeader()?.court ?? null };
		await p.click('#cb-discard');
		await sleep(200);
		return { pass: during.retry === true && during.discard === true && !after.conflict && after.court === 'SYN RETRY COURT' && after.stored === 'SYN RETRY COURT', evidence: { during, after } };
	});
	await S('CL-RETRY-INFLIGHT', 'caselines_tab', 'review L1: Retry pressed during a link in flight is disabled and the path is linked once', async () => {
		await p.go(C, 'caselines_tab');
		const path = 'Synthetic/retry once.pdf';
		await p.type('#cl-path', path);
		await withBusyStore(A.dataDir, 12500, async () => { await p.click('#cl-link'); await p.waitFor(`document.getElementById('cl-error')`, 20000); });
		let during;
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.click('#cl-retry');
			await p.waitFor(`document.querySelector('#main').dataset.busy === '1'`, 5000);
			during = await p.evaluate(`({ retry: document.getElementById('cl-retry')?.disabled ?? null, link: document.getElementById('cl-link').disabled })`);
			await p.click('#cl-retry');
		});
		await idleBusy(p);
		await sleep(500);
		const rows = A.work("SELECT fields FROM register_row WHERE store = 'caselines-links'").filter((x) => JSON.parse(x.fields).path === path).length;
		return { pass: during.retry === true && during.link === true && rows === 1, evidence: { during, rows } };
	});
	await S('BUNDLES-NARROW', 'discovery_tab', 'review M2: no bundle view scrolls sideways at 320 or 390 px, with a 64-character case id and long unbroken file names (Court Bundle list and items, CaseLines, Discovery list and bundle view)', async () => {
		const long = (tag, n = 90) => `SYN_${tag}_`.padEnd(n, 'abcdefghijklmnopqrstuvwxyz0123456789');
		const lf = `${long('DISCOVERY_FILE')}.pdf`;
		const longPdf = `${long('BUILDER_SOURCE', 120)}.pdf`;
		writeFileSync(join(PDFS, longPdf), makePdf({ name: longPdf, pages: 2 }));
		const nc = await buildCase(join(tmp, 'case-narrow'), {
			caseId: 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz'),
			edit: (r) => {
				r.SCHED.discovery.push({ no: 2, date: '04/02/2001', desc: long('DESCRIPTION', 70), co: 'C', nfiles: 1, files: [{ fn: lf, url: url(`DISCOVERY A/${lf}`), co: 'C' }] });
				const bl = r.DATA.bundles.list;
				bl.push({ ...bl[0], no: '2', name: long('BUNDLE_NAME', 70), title: long('BUNDLE_NAME', 70), note: long('NOTE', 70),
					rows: [{ key: long('KEY', 40), n: 1, desc: long('ITEM_DESC', 90), date: '', from: 1, to: 3, pages: 3, parts: [{ url: url(`NOT INDEXED/${lf}`), name: `(1) ${lf}`, rel: lf, from: 2, to: 4 }] }] });
			},
		});
		const imp2 = await A.c.importPkg(nc.caseDir, nc.pkgDir);
		if (!imp2.importId) throw new Error(`narrow case import failed: ${imp2.status}`);
		const N = vpath(nc.resultsVersion);
		const out = {};
		let err = null;
		try {
			for (const width of [320, 390]) {
				await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
				const sw = async (name) => { await sleep(150); out[`${width}:${name}`] = await p.evaluate(`(() => { const sw = document.documentElement.scrollWidth, vw = document.documentElement.clientWidth; const over = sw > vw ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > vw + 1 || (e.scrollWidth > e.clientWidth + 1 && !e.matches('.visually-hidden'))).slice(0, 12).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right) + '/' + e.scrollWidth) : undefined; return { sw, vw, want: ${width}, over }; })()`); };
				await p.go(`${N}/bundles/court_bundle_tab`, 'court_bundle_tab'); await sw('court-list');
				await p.go(`${N}/bundles/court_bundle_tab?b=2&tab=items`, 'court_bundle_tab'); await sw('court-items');
				await p.go(`${N}/bundles/court_bundle_tab?view=build`, 'court_bundle_tab');
				await pick(p, [longPdf]); await p.waitFor(`document.querySelectorAll('#cbb-items tr[data-item]').length === 1`, 30000); await sw('court-build');
				await p.go(`${N}/bundles/caselines_tab`, 'caselines_tab');
				if (width === 320) { await p.type('#cl-path', `${long('LINKED_PATH', 100)}.pdf`); await p.click('#cl-link'); await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length >= 1`, 30000); }
				await sw('caselines');
				await p.go(`${N}/bundles/discovery_tab`, 'discovery_tab'); await sw('discovery-list');
				if (width === 320) { await p.evaluate(`document.querySelector(${JSON.stringify(chip(lf))}).click()`); await p.idle(); }
				await p.evaluate(`document.getElementById('ds-build').click()`); await p.waitFor(`document.getElementById('ds-bundle-table')`, 30000); await sw('discovery-bundle');
			}
		} catch (e) { err = { message: String(e.message).slice(0, 120), url: await p.evaluate(`location.pathname + location.search`), keys: await p.evaluate(`[...document.querySelectorAll('#ds-list .ds-chip')].map((c) => c.dataset.key)`), box: await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(chip(lf))}); const r = e?.getBoundingClientRect(); return e ? [r.left, r.top, r.width, r.height, e.checked, e.disabled] : null; })()`) }; } finally { await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {}); }
		const wide = Object.entries(out).filter(([, m]) => m.sw !== m.vw || m.vw !== m.want);
		return { pass: !err && Object.keys(out).length === 12 && wide.length === 0, evidence: { err, wide: Object.fromEntries(wide), n: Object.keys(out).length } };
	});
	await S('CB-LIMIT', 'court_bundle_tab', 'D5: a header field over 2,000 characters is refused with the field and the limit named, every typed field kept, nothing written', async () => {
		await p.go(B, 'court_bundle_tab');
		const before = storedHeader();
		const long = 'Synthetic citation line. '.repeat(104);
		await setVal(p, 'cbh_claimant', long);
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('cb-error')`, 20000);
		const r = { error: await p.text('#cb-error'), len: (await val(p, 'cbh_claimant')).length, stored: storedHeader()?.claimant === before?.claimant };
		await p.click('#cb-discard');
		await sleep(200);
		return { pass: /“Plaintiff \/ claimant citation” is 2,600 characters; the limit is 2,000 per field/.test(r.error) && r.len === 2600 && r.stored && !(await p.evaluate(`!!document.getElementById('cb-error')`)), evidence: r };
	});
	await S('CB-TWOTABS', 'court_bundle_tab', 'D3: two tabs on the header: the second save over the first is refused (409), keeps its typed fields and shows the stored header; nothing is reverted', async () => {
		const p2 = await page(b, A.origin);
		try {
			await p.go(B, 'court_bundle_tab');
			await p2.go(B, 'court_bundle_tab');
			await p.type('#cbh_court', 'SYN TAB ONE COURT');
			await p.click('#cb-save');
			await idleBusy(p);
			await p2.type('#cbh_judge', 'SYN TAB TWO JUDGE');
			await p2.click('#cb-save');
			await p2.waitFor(`document.getElementById('cb-error')`, 20000);
			const r = { error: await p2.text('#cb-error'), conflict: await p2.text('#cb-conflict [data-field="court"]'), judge: await val(p2, 'cbh_judge'), stored: storedHeader() };
			await p2.click('#cb-discard');
			await sleep(300);
			const used = { court: await val(p2, 'cbh_court'), judge: await val(p2, 'cbh_judge'), error: await p2.evaluate(`!!document.getElementById('cb-error')`) };
			return { pass: /changed in another tab/.test(r.error) && r.conflict === 'SYN TAB ONE COURT' && r.judge === 'SYN TAB TWO JUDGE' && r.stored?.court === 'SYN TAB ONE COURT' && r.stored?.judge !== 'SYN TAB TWO JUDGE' && used.court === 'SYN TAB ONE COURT' && !used.error, evidence: { r: { ...r, stored: { court: r.stored?.court, judge: r.stored?.judge } }, used } };
		} finally { await p2.close(); }
	});
	const customRows = () => A.work('SELECT case_id, id, no, name, rows FROM bundles_custom ORDER BY seq');
	await S('CB-BUILD', 'court_bundle_tab', 'builder: pick two PDFs (a repeat skipped, a protected one refused), reorder, Create and Index only give valid PDFs, the built PDF previews in the page (a frame of its blob URL), the Word index links into the bundle; text typed while Save is pending is kept; the saved bundle is listed after a reload; Back from the builder focuses the heading', async () => {
		await p.go(B, 'court_bundle_tab');
		await p.click('#cb-build');
		await p.waitFor(`document.getElementById('cbbfile')`, 30000);
		const mk = b.mark();
		await pick(p, ['Alpha_Statement.pdf', 'Beta_Letter.pdf']);
		await p.waitFor(`document.querySelectorAll('#cbbfiles tbody tr').length === 2 && !document.getElementById('cbbmsg').textContent`, 30000);
		await pick(p, ['Alpha_Statement.pdf', 'Locked.pdf']);
		const refused = await until(() => b.since(mk).dialogs.some((d) => /Locked\.pdf: the file is password-protected/.test(d.message)));
		await p.waitFor(`!document.getElementById('cbbmsg').textContent`, 30000);
		const files = await p.evaluate(`[...document.querySelectorAll('#cbbfiles tbody tr')].map((r) => r.cells[0].textContent.trim() + ':' + r.cells[1].textContent.trim())`);
		const descs = () => p.evaluate(`[...document.querySelectorAll('#cbb-items tr[data-item] input[aria-label^="Description"]')].map((e) => e.value)`);
		const before = await descs();
		await p.click('button[aria-label="Move item 2 up"]');
		const after = await descs();
		const total = await p.text('#cbbtotal');
		await p.type('#cbbname', 'Synthetic Build');
		await p.evaluate(`window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI))`);
		await p.click('#cbbrun');
		await p.waitFor(`document.getElementById('cbbdownload')`, 60000);
		// v5's in-page preview: the frame loads the builder's own blob URL (frame-src blob:) and Chromium's PDF viewer renders it.
		// No sandbox: Chromium leaves a sandboxed PDF frame empty, whatever the sandbox tokens.
		const preview = await p.evaluate(`new Promise((ok) => {
			const f = document.getElementById('cbbpreview');
			const done = () => { let d = null; try { d = f.contentDocument; } catch { /* cross-origin error page */ }
				ok({ src: f?.getAttribute('src') ?? null, href: document.getElementById('cbbdownload').getAttribute('href'), sandbox: f?.getAttribute('sandbox') ?? null, url: d?.URL ?? null, type: d?.contentType ?? null, viewer: !!d?.querySelector('embed[type="application/pdf"], link[href$="/pdf_embedder.css"]'), csp: window.__csp }); };
			if (!f) return done();
			const loaded = () => f.contentDocument?.readyState === 'complete' && f.contentDocument.URL.startsWith('blob:');
			if (loaded()) return setTimeout(done, 300);
			f.addEventListener('load', () => setTimeout(done, 300), { once: true });
			setTimeout(done, 15000);
		})`);
		await shot('court-bundle-builder');
		await p.evaluate(`document.getElementById('cbbdownload').click()`);
		await p.click('#cbbindex');
		await p.click('#cbbword');
		await sleep(300);
		const dl = await p.downloads();
		const get = (n) => { const d = dl.find((x) => x.name === n); return d ? Buffer.from(d.base64, 'base64') : null; };
		const full = get('SYNTHETIC_BUILD.pdf'), idx = get('Index_SYNTHETIC_BUILD.pdf'), word = get('Index_SYNTHETIC_BUILD.docx');
		const ft = full ? await pdfText(full) : '';
		const pdfs = {
			full: full && { pages: await pdfPages(full), order: ft.indexOf('BETA') >= 0 && ft.indexOf('BETA') < ft.indexOf('ALPHA'), goTo: /\/S\s*\/GoTo\b/.test(full.toString('latin1')) },
			idx: idx && { pages: await pdfPages(idx), goToR: /\/S\s*\/GoToR/.test(idx.toString('latin1')) && idx.toString('latin1').includes('(SYNTHETIC_BUILD.pdf)') },
			word: word && { text: /BETA/.test(docxText(word)), links: [...(unzip(word).get('word/_rels/document.xml.rels')?.toString('utf8') ?? '').matchAll(/Target="([^"]*#page=\d+)"/g)].map((m) => m[1]) },
		};
		// Save with the store held: text typed into an item while the save is pending stays in the builder
		let during;
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.click('#cbbsave');
			await p.waitFor(`document.querySelector('#cbbout .saving')`, 5000);
			await p.type('#cbb-items tr[data-item="1"] input', 'SYN TYPED WHILE SAVING');
			during = await p.text('#cbbout .saving');
		});
		await p.waitFor(`new URLSearchParams(location.search).get('b') === 'C1'`, 30000);
		const opened = await p.text('#cb-bundle-h');
		await p.evaluate('history.back()');
		await p.waitFor(`document.getElementById('cbbsaved')`, 30000);
		const kept = { desc: (await descs())[0], saved: await p.text('#cbbsaved'), error: await p.evaluate(`document.getElementById('cbb-save-error')?.textContent ?? null`) };
		await p.evaluate('history.back()');
		await p.waitFor(`!new URLSearchParams(location.search).get('view') && document.getElementById('cb-list')`, 30000);
		await sleep(200);
		const back = await p.evaluate(`document.activeElement?.matches?.('h1[data-page-heading]') ?? false`);
		const stored = customRows();
		await p.go(B, 'court_bundle_tab');
		const listed = await p.evaluate(`[...document.querySelectorAll('#cb-list tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join('|'))`);
		const sr = stored.length === 1 ? JSON.parse(stored[0].rows) : [];
		return {
			pass: refused && J(files) === J(['Alpha_Statement.pdf:3', 'Beta_Letter.pdf:2']) && J(before) === J(['ALPHA_STATEMENT', 'BETA_LETTER']) && J(after) === J(['BETA_LETTER', 'ALPHA_STATEMENT']) && total === 'Total: 2 items · 5 pages'
				&& pdfs.full?.pages === 6 && pdfs.full.order && pdfs.full.goTo && pdfs.idx?.pages === 1 && pdfs.idx.goToR && pdfs.word?.text && J(pdfs.word.links) === J(['SYNTHETIC_BUILD.pdf#page=2', 'SYNTHETIC_BUILD.pdf#page=2', 'SYNTHETIC_BUILD.pdf#page=4', 'SYNTHETIC_BUILD.pdf#page=4'])
				&& during === 'Saving…' && kept.desc === 'SYN TYPED WHILE SAVING' && kept.saved === 'Saved to the bundle list as C1' && kept.error === null && back
				&& stored.length === 1 && stored[0].no === 'C1' && stored[0].name === 'SYNTHETIC BUILD' && J(sr.map((r) => [r.desc, r.from, r.to, r.parts.map((x) => x.name)])) === J([['BETA_LETTER', 1, 2, ['Beta_Letter.pdf']], ['ALPHA_STATEMENT', 3, 5, ['Alpha_Statement.pdf']]])
				&& listed.length === 3 && /^C1\|.*SYNTHETIC BUILD.*\|2\|5\|custom complete\|.*Delete$/.test(listed[2]) && /SYNTHETIC BUILD/.test(opened)
				&& /^blob:/.test(preview.href) && preview.src === `${preview.href}#page=1` && preview.url === preview.src && preview.type === 'application/pdf' && preview.viewer && preview.sandbox === null && preview.csp.length === 0,
			evidence: { refused, files, before, after, total, pdfs, preview, during, opened, kept, back, stored: stored.map((r) => ({ ...r, rows: r.rows.length })), sr, listed, dl: dl.map((d) => d.name) },
		};
	});
	await S('CB-BUILD-DELETE', 'court_bundle_tab', 'saved bundles: a Delete refused by a busy store keeps its own error while another bundle\'s Delete dialog is answered (no error moves to that row); Delete asks first and removes only the list entry', async () => {
		const entry = { name: 'SYN SECOND', pages: 1, indexPages: 1, filePages: 2, note: '', rows: [{ n: 1, key: '', desc: 'SYN ITEM', pages: 1, from: 1, to: 1, parts: [{ rel: 'x.pdf', url: '', name: 'x.pdf', from: 1, to: 1 }] }] };
		await p.go(B, 'court_bundle_tab');
		const posted = await p.evaluate(`(async () => { const f = new FormData(); f.append('id', 'osynsecond'); f.append('bundle', ${J(J(entry))}); const r = await fetch(location.pathname + '?/save', { method: 'POST', body: f, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } }); return r.status; })()`);
		await p.go(B, 'court_bundle_tab');
		const mk = b.mark();
		const release = holdStore(A.dataDir);
		let mid;
		try {
			await p.evaluate(`window.confirm = () => true`);
			await p.click('[data-delete="C1"]');
			await p.waitFor(`document.querySelector('[data-delete="C1"]')?.disabled`, 5000);
			await p.evaluate(`window.confirm = () => false`);
			await p.click('[data-delete="C2"]');
			await p.waitFor(`document.querySelector('[data-delete-error="C1"]')`, 40000);
			mid = { c1: await p.text('[data-delete-error="C1"]'), c2: await p.evaluate(`!!document.querySelector('[data-delete-error="C2"]')`), alerts: await p.evaluate(`document.querySelectorAll('#main [role="alert"]').length`) };
		} finally { release(); }
		const rowsMid = customRows().map((r) => r.no);
		await p.evaluate(`window.confirm = () => true`);
		await p.click('[data-delete="C1"]');
		await p.waitFor(`!document.querySelector('[data-delete="C1"]')`, 30000);
		const after = { rows: customRows().map((r) => r.no), error: await p.evaluate(`!!document.querySelector('[data-delete-error]')`) };
		await p.click('[data-delete="C2"]');
		await p.waitFor(`!document.querySelector('[data-delete="C2"]')`, 30000);
		const dialogs = b.since(mk).dialogs.length;
		return { pass: posted === 200 && /^Not removed: .*busy/.test(mid.c1) && !mid.c2 && mid.alerts === 1 && J(rowsMid) === J(['C1', 'C2']) && J(after.rows) === J(['C2']) && !after.error && customRows().length === 0 && dialogs === 0, evidence: { posted, mid, rowsMid, after, dialogs } };
	});
	await S('CB-BUILD-RACE', 'court_bundle_tab', 'builder: Create Bundle pressed while Save is pending does not revoke the PDF being saved; the saved bundle\'s Bundle PDF link still loads a PDF (IDR-366)', async () => {
		await p.go(B, 'court_bundle_tab');
		await p.click('#cb-build');
		await p.waitFor(`document.getElementById('cbbfile')`, 30000);
		await pick(p, ['Alpha_Statement.pdf', 'Beta_Letter.pdf']);
		await p.waitFor(`document.querySelectorAll('#cbbfiles tbody tr').length === 2 && !document.getElementById('cbbmsg').textContent`, 30000);
		await p.type('#cbbname', 'Synthetic Race');
		await p.click('#cbbrun');
		await p.waitFor(`document.getElementById('cbbdownload')`, 60000);
		const first = await p.evaluate(`document.getElementById('cbbdownload').getAttribute('href')`);
		await withBusyStore(A.dataDir, 2500, async () => {
			await p.click('#cbbsave');
			await p.waitFor(`document.querySelector('#cbbout .saving')`, 5000);
			await p.click('#cbbrun');
			await p.waitFor(`document.getElementById('cbbdownload')?.getAttribute('href') !== ${J(first)}`, 60000);
		});
		await p.waitFor(`!document.querySelector('#cbbout .saving')`, 30000);
		await p.click('#cb-builder-back');
		await p.waitFor(`document.querySelector('#cb-list tr:has(.badge.b-info) a[href^="blob:"]')`, 30000);
		const link = await p.evaluate(`(async () => {
			const href = document.querySelector('#cb-list tr:has(.badge.b-info) a[href^="blob:"]').getAttribute('href');
			try { const r = await fetch(href); const u = new Uint8Array(await r.arrayBuffer()); return { href, same: href === ${J(first)}, type: r.headers.get('content-type'), head: String.fromCharCode(...u.slice(0, 5)), size: u.length }; }
			catch (e) { return { href, same: href === ${J(first)}, error: String(e) }; }
		})()`);
		return { pass: link.same && link.head === '%PDF-' && link.size > 500 && !link.error, evidence: { first, link } };
	});
	await S('NOJS', 'discovery_tab', 'D4: without JavaScript no control of the three views looks usable, and each view says saving needs JavaScript; the bundle builder says it needs JavaScript', async () => {
		const out = {};
		await p.s('Emulation.setScriptExecutionDisabled', { value: true });
		try {
			for (const [view, path, note] of [['discovery_tab', D, '#ds-nojs'], ['court_bundle_tab', B, '#cb-nojs'], ['caselines_tab', C, '#cl-nojs'], ['court_bundle_tab', `${B}?view=build`, '#cb-builder-nojs']]) {
				await p.navigate(A.origin + path, { timeout: 30000 });
				await p.waitFor(`document.querySelector('main[data-ready="${view}"]')`, 30000);
				out[path.endsWith('build') ? 'court_bundle_build' : view] = { usable: await usableControls(p), note: await p.text(note), hydrated: await p.evaluate(`!!document.querySelector('main[data-hydrated]')`) };
			}
		} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
		return { pass: Object.values(out).every((o) => o.usable.length === 0 && /needs? JavaScript/.test(o.note) && !o.hydrated) && Object.keys(out).length === 4, evidence: out };
	});

	// a second server and case: a repeated bundle number and page, a bulk supplementary schedule (40 x 100 files), an
	// Original item with unmarked files; a third case without a page-text index and with a repeated item number
	const BULK = 40, PER = 100;
	const bulkPath = (i, j) => `SYNTHETIC BULK FOLDER WITH A LONG NAME/SUBFOLDER ${i}/Synthetic item ${i} file ${j} with a long descriptive file name.pdf`;
	const caseB = await buildCase(join(tmp, 'case-b'), {
		caseId: 'e2e-case-b',
		edit: (r) => {
			r.SCHED.discovery = [
				{ no: 1, date: '', desc: 'Synthetic original item', co: 'O', nfiles: 2, files: [{ fn: 'orig one.pdf', url: url('SYN B/orig one.pdf'), co: '' }, { fn: 'orig two.pdf', url: url('SYN B/orig two.pdf'), co: '' }] },
				{ no: 3, date: '', desc: 'Synthetic third item', co: 'C', nfiles: 1, files: [{ fn: 'repeat.pdf', url: url('SYN B/repeat.pdf'), co: 'C' }] },
				{ no: 2, date: '', desc: 'Synthetic plain item', co: 'C', nfiles: 2, files: [{ fn: 'plain one.pdf', url: url('SYN B/plain one.pdf'), co: 'C' }, { fn: 'plain two.pdf', url: url('SYN B/plain two.pdf'), co: 'C' }] },
			];
			r.SCHED.supplementary = Array.from({ length: BULK }, (_, i) => ({ no: i + 1, date: '', desc: `Synthetic bulk item ${i + 1}`, co: 'C', nfiles: PER, files: Array.from({ length: PER }, (_, j) => ({ fn: `file ${j}.pdf`, url: url(bulkPath(i + 1, j)), co: 'C' })) }));
			r.CASELINES.index = [[1, 'Invented page one'], [1, 'Invented page one repeated'], [2, 'Other words']];
			r.CASELINES.pages = 2;
			const bl = r.DATA.bundles.list;
			bl.push({ ...bl[0], title: 'Synthetic repeated bundle', name: 'Synthetic repeated bundle' }, { ...bl[0], no: '2', name: 'Unbuilt', title: 'Unbuilt', file: '', indexFile: '' });
		},
	});
	// case C: no page-text index, and a Discovery schedule that repeats an item number (case B has none, so its Discovery
	// scenarios also run, and fail on their own defects, at a revision that blanks a view with repeated numbers)
	const caseC = await buildCase(join(tmp, 'case-c'), {
		caseId: 'e2e-case-c',
		edit: (r) => {
			r.CASELINES.index = [];
			r.SCHED.discovery = [
				{ no: 1, date: '', desc: 'Synthetic original item', co: 'O', nfiles: 1, files: [{ fn: 'c one.pdf', url: url('SYN C/c one.pdf'), co: '' }] },
				{ no: 1, date: '', desc: 'Synthetic repeated number', co: 'C', nfiles: 1, files: [{ fn: 'c repeat.pdf', url: url('SYN C/c repeat.pdf'), co: 'C' }] },
				{ no: 2, date: '', desc: 'Synthetic plain item', co: 'C', nfiles: 1, files: [{ fn: 'c plain.pdf', url: url('SYN C/c plain.pdf'), co: 'C' }] },
			];
		},
	});
	const SB = appServer({ name: 'b', root: ROOT, buildDir: BUILD, port: 43102, origPort: 43103, dir: tmp });
	const { startServer } = await import('../pilot/lib/server.mjs');
	SB.srv = await startServer({ root: ROOT, port: SB.port, origPort: SB.origPort, dataDir: SB.dataDir, buildDir: BUILD, logFile: SB.logFile, env });
	try {
		for (const sc2 of [caseB, caseC]) {
			const imp2 = await SB.c.importPkg(sc2.caseDir, sc2.pkgDir);
			const act2 = await SB.c.activate(imp2.importId);
			if (!imp2.importId || act2.status >= 400) throw new Error(`import/activate failed: ${JSON.stringify({ imp: imp2.status, act: act2.status })}`);
		}
		const VB = vpath(caseB.resultsVersion), VC = vpath(caseC.resultsVersion);
		const DB = `${VB}/bundles/discovery_tab`, BB = `${VB}/bundles/court_bundle_tab`, CB_ = `${VB}/bundles/caselines_tab`;
		const q = await page(b, SB.origin);
		const marksB = () => SB.work('SELECT locator, selected, co FROM bundles_schedule_mark ORDER BY locator');
		const rowB = (fn) => marksB().find((x) => x.locator.endsWith('/' + fn)) ?? null;
		const coBtn = (fn, label) => `#ds-list .ds-chip[data-key$=${J('/' + fn)}] button[aria-label=${label}]`;
		const pend = (pp, t = 120000) => pp.waitFor(`document.querySelector('#main')?.dataset.pending === '0'`, t);
		const exceptions = (mk) => b.since(mk).console.filter((c) => c.kind === 'exception');

		await S('DS-DUP', 'discovery_tab', 'D8: a repeated item number renders every row, hydrates without an exception and is flagged', async () => {
			const mk = b.mark();
			await q.go(`${VC}/bundles/discovery_tab`, 'discovery_tab');
			const r = await q.evaluate(`({ rows: [...document.querySelectorAll('#ds-list tr[data-item]')].map((t) => t.querySelector('.tx').textContent.trim()), dup: document.querySelectorAll('#ds-list .dup').length, hydrated: !!document.querySelector('main[data-hydrated]') })`);
			const ex = exceptions(mk);
			return { pass: r.rows.join('|') === 'Synthetic original item|Synthetic repeated number|Synthetic plain item' && r.dup === 2 && r.hydrated && ex.length === 0, evidence: { r, ex } };
		});
		await S('CB-DUP', 'court_bundle_tab', 'D8: a repeated bundle number renders every row, flagged, each opening its own bundle; the copy is v5\'s now that the builder assembles bundles (GRS-19)', async () => {
			const mk = b.mark();
			await q.go(BB, 'court_bundle_tab');
			const r = await q.evaluate(`({ rows: [...document.querySelectorAll('#cb-list tbody tr')].map((t) => t.cells[1].textContent.trim()), dup: document.querySelectorAll('#cb-list .dup').length, sub: document.getElementById('main').textContent.replace(/\\s+/g, ' ') })`);
			await q.evaluate(`document.querySelectorAll('#cb-list tbody tr')[1].querySelector('button').setAttribute('data-t', 'open2')`);
			await q.click('[data-t="open2"]');
			await q.waitFor(`document.getElementById('cb-bundle-h')`);
			const opened = { title: await q.text('#cb-bundle-h'), search: await q.evaluate('location.search') };
			const ex = exceptions(mk);
			return { pass: r.rows.length === 3 && r.dup === 2 && opened.title === 'Synthetic repeated bundle' && /[?&]b=1&at=1/.test(opened.search) && /paginated pages\. Every bundle is a finished PDF: index first, then the extracted documents, numbered continuously from page 1\./.test(r.sub) && /assembled and numbered/.test(r.sub) && ex.length === 0, evidence: { rows: r.rows, dup: r.dup, opened, ex } };
		});
		await S('CL-DUP', 'caselines_tab', 'D8: a page number the page-text index repeats renders every hit, flagged', async () => {
			const mk = b.mark();
			await q.go(`${CB_}?q=invented`, 'caselines_tab');
			const r = await q.evaluate(`({ hits: document.querySelectorAll('.cl-hit').length, dup: document.querySelectorAll('.cl-hit .dup').length })`);
			const ex = exceptions(mk);
			return { pass: r.hits === 2 && r.dup === 2 && ex.length === 0, evidence: { r, ex } };
		});
		await S('CL-NOINDEX', 'caselines_tab', 'D14: without a page-text index the search control says so and a query answers that the bundle cannot be searched', async () => {
			await q.go(`${VC}/bundles/caselines_tab`, 'caselines_tab');
			const go = await q.evaluate(`({ text: document.getElementById('cl-go').textContent.trim(), disabled: document.getElementById('cl-go').disabled })`);
			await q.go(`${VC}/bundles/caselines_tab?q=court`, 'caselines_tab');
			const t = await q.text('#cl-no-index');
			return { pass: go.disabled && go.text === 'Search unavailable (no page-text index)' && t === 'This package has no page-text index, so the bundle cannot be searched here.', evidence: { go, t } };
		});
		await S('DS-COVER-PARTIAL', 'discovery_tab', 'D15: marking one unmarked file of an Original item O keeps the cover O', async () => {
			await q.go(DB, 'discovery_tab');
			await q.click(coBtn('orig one.pdf', 'Original'));
			await pend(q);
			await q.downloads();
			await q.click('#ds-cover-dl');
			await sleep(300);
			const cover = text((await q.downloads())[0]);
			return { pass: /<td>Synthetic original item<\/td><td class="d"><\/td><td class="co">O<\/td>/.test(cover), evidence: { row: /<td>Synthetic original item<\/td>.{0,60}/.exec(cover)?.[0] } };
		});
		await S('DS-TWOTABS', 'discovery_tab', 'D3: two tabs on one file while the store is busy: tab 1 ticks, tab 2 marks O; both survive and neither shows an error', async () => {
			const q2 = await page(b, SB.origin);
			try {
				await q.go(DB, 'discovery_tab');
				await q2.go(DB, 'discovery_tab');
				// lane 04's timing (V4-TWOTABS-LOCKED): tab 2 acts 1.2 s after tab 1, and the lock is held 8.2 s in all, under
				// the store's ~9.5 s of retries, so tab 2's request is read while tab 1's write still waits
				await withBusyStore(SB.dataDir, 8200, async () => { await q.click(chip('plain one.pdf')); await sleep(1200); await q2.click(coBtn('plain one.pdf', 'Original')); });
				await pend(q); await pend(q2);
				const r = { row: rowB('plain one.pdf'), e1: await q.evaluate(`!!document.getElementById('ds-error')`), e2: await q2.evaluate(`!!document.getElementById('ds-error')`) };
				await q.go(DB, 'discovery_tab');
				const shown = await q.evaluate(`({ ticked: document.querySelector(${J(chip('plain one.pdf'))}).checked, o: document.querySelector(${J(coBtn('plain one.pdf', 'Original'))}).getAttribute('aria-pressed') })`);
				return { pass: r.row?.selected === 1 && r.row?.co === 'O' && !r.e1 && !r.e2 && shown.ticked && shown.o === 'true', evidence: { r, shown } };
			} finally { await q2.close(); }
		});
		await S('DS-CO-CONFLICT', 'discovery_tab', 'D3: a Copy/Original mark over another tab\'s different mark is refused visibly, keeps both (the stored mark named, this tab\'s shown unsaved); Retry saves it', async () => {
			const q2 = await page(b, SB.origin);
			try {
				await q.go(DB, 'discovery_tab');
				await q2.go(DB, 'discovery_tab');
				await q.click(coBtn('plain two.pdf', 'Copy'));
				await pend(q);
				await q.click(coBtn('plain two.pdf', 'Original'));
				await pend(q);
				await q2.click(coBtn('plain two.pdf', 'Copy'));
				await q2.waitFor(`document.getElementById('ds-error')`, 20000);
				const r = { error: await q2.text('#ds-error'), chip: await q2.evaluate(`({ c: document.querySelector(${J(coBtn('plain two.pdf', 'Copy'))}).getAttribute('aria-pressed'), unsaved: document.querySelector('#ds-list .ds-chip[data-key$="/plain two.pdf"]').classList.contains('unsaved') })`), stored: rowB('plain two.pdf')?.co };
				await q2.click('.ds-retry-one');
				await pend(q2);
				return { pass: /marked differently in another tab/.test(r.error) && /plain two\.pdf is Original/.test(r.error) && r.chip.c === 'true' && r.chip.unsaved && r.stored === 'O' && rowB('plain two.pdf')?.co === 'C' && !(await q2.evaluate(`!!document.getElementById('ds-error')`)), evidence: r };
			} finally { await q2.close(); }
		});
		await S('DS-FAIL-SLOTS', 'discovery_tab', 'D4: a failed tick keeps its own error and Retry while a later tick on another file is sent and saved; Retry saves the first', async () => {
			await q.go(DB, 'discovery_tab');
			const was = rowB('plain one.pdf')?.selected;
			const release = holdStore(SB.dataDir);
			try {
				await q.click(chip('plain one.pdf'));
				await q.waitFor(`document.getElementById('ds-error')`, 20000);
			} finally { release(); }
			await q.click(chip('plain two.pdf'));
			await pend(q);
			const r = { error: await q.text('#ds-error'), n: await q.count('#ds-error .ds-fail'), one: rowB('plain one.pdf')?.selected ?? 0, two: rowB('plain two.pdf')?.selected ?? 0, unsaved: await q.evaluate(`document.querySelector('#ds-list .ds-chip[data-key$="/plain one.pdf"]').classList.contains('unsaved')`) };
			await q.click('#ds-retry');
			await pend(q);
			const one = rowB('plain one.pdf')?.selected ?? 0;
			return { pass: was === 1 && /busy/.test(r.error) && /untick 1 file/.test(r.error) && r.n === 1 && r.one === 1 && r.two === 1 && r.unsaved && one === 0 && !(await q.evaluate(`!!document.getElementById('ds-error')`)), evidence: { r, one } };
		});
		await S('DS-LEAVE', 'discovery_tab', 'D4: with a failed change, an in-app navigation asks first and a reload warns; refusing keeps the page and the change; Discard restores the stored state', async () => {
			await q.go(DB, 'discovery_tab');
			const release = holdStore(SB.dataDir);
			try {
				await q.click(chip('repeat.pdf'));
				await q.waitFor(`document.getElementById('ds-error')`, 20000);
			} finally { release(); }
			await q.evaluate('window.__stay = 1');
			let mk = b.mark();
			await q.click('#nav-court_bundle_tab');
			await sleep(800);
			const inApp = { dialogs: b.since(mk).dialogs.map((d) => d.type), path: await q.evaluate('location.pathname'), stay: await q.evaluate('window.__stay') };
			mk = b.mark();
			await q.s('Page.reload', {});
			await sleep(1200);
			const reload = { dialogs: b.since(mk).dialogs.map((d) => d.type), stay: await q.evaluate('window.__stay').catch(() => null) };
			await q.click('.ds-discard');
			await sleep(200);
			const after = { error: await q.evaluate(`!!document.getElementById('ds-error')`), ticked: await q.evaluate(`document.querySelector(${J(chip('repeat.pdf'))}).checked`) };
			return { pass: inApp.dialogs.includes('confirm') && inApp.path === DB && inApp.stay === 1 && reload.dialogs.includes('beforeunload') && reload.stay === 1 && !after.error && !after.ticked, evidence: { inApp, reload, after } };
		});
		await S('DS-PARTIAL-ACTION', 'discovery_tab', 'D6: a 2,000-file Original mark that meets a lock taken mid-write answers exactly how many files it saved, matching the store; never "Not saved"', async () => {
			await q.go(DB, 'discovery_tab');
			// lane 03's repro: one POST of 2,000 keys (no base marks, so it stays under the body limit as at 2e7dd60)
			const keys = []; for (let i = 1; i <= 20; i++) for (let j = 0; j < PER; j++) keys.push(bulkPath(i, j));
			const post = q.evaluate(`(async () => { const f = new FormData(); f.append('val', 'O'); for (const k of ${J(keys)}) f.append('key', k); const r = await fetch(location.pathname + '?/co', { method: 'POST', body: f, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } }); return r.text(); })()`);
			// take the lock from outside once the write has stored some files (retrying while the app holds a transaction)
			const ks = new Set(keys);
			const storedO = () => marksB().filter((x) => x.co === 'O' && ks.has(x.locator)).length;
			for (let i = 0; i < 1000 && !storedO(); i++) await sleep(5);
			let release = null;
			for (let i = 0; i < 400 && !release; i++) { try { release = holdStore(SB.dataDir); } catch { await sleep(2); } }
			let res;
			try { res = await post; } finally { release?.(); }
			const m = /Partly saved: ([\d,]+) files? saved/.exec(res);
			const n = m ? Number(m[1].replace(/,/g, '')) : -1;
			const stored = storedO();
			return { pass: !!release && n > 0 && n < keys.length && n === stored && !/Not saved/.test(res), evidence: { n, stored, of: keys.length, locked: !!release, says: res.slice(0, 400) } };
		});
		await S('DS-LARGE', 'discovery_tab', 'D7: 40 items x 100 files: tick all, Mark Copy marks all 4,000; untick one item; reload shows 3,900; a busy store fails one chunk and Retry finishes Mark Original', async () => {
			await q.go(DB, 'discovery_tab');
			await q.click('#main .ds-switch button[data-mode="supplementary"]');
			await pend(q);
			for (let i = 1; i <= BULK; i++) await q.click(`tr[data-item="supplementary-${i}"] td:first-child input`);
			await pend(q, 300000);
			await q.click('#ds-mark-c');
			await pend(q, 300000);
			const copy = { c: marksB().filter((x) => x.co === 'C' && x.locator.startsWith('SYNTHETIC BULK')).length, error: await q.evaluate(`document.getElementById('ds-error')?.textContent ?? null`) };
			await q.click('tr[data-item="supplementary-1"] td:first-child input');
			await pend(q);
			await q.go(DB, 'discovery_tab');
			const bulk = (x) => x.locator.startsWith('SYNTHETIC BULK');
			const extra = marksB().filter((x) => x.selected === 1 && !bulk(x)).length; // files ticked by the steps above
			const reloaded = { count: await q.text('#ds-count'), extra, stored: marksB().filter((x) => x.selected === 1 && bulk(x)).length };
			const release = holdStore(SB.dataDir);
			try {
				await q.click('#ds-mark-o');
				await q.waitFor(`document.getElementById('ds-error')`, 30000);
			} finally { release(); }
			await pend(q, 300000);
			const failedOnce = await q.text('#ds-error');
			await q.click('#ds-retry');
			await pend(q, 300000);
			const o = marksB().filter((x) => x.co === 'O' && x.selected === 1 && bulk(x)).length;
			return { pass: copy.c === BULK * PER && copy.error === null && reloaded.count === String(3900 + extra) && reloaded.stored === 3900 && /busy/.test(failedOnce) && o === 3900 && !(await q.evaluate(`!!document.getElementById('ds-error')`)), evidence: { copy, reloaded, failedOnce: failedOnce.slice(0, 200), o } };
		});
	} finally { await SB.stop().catch(() => {}); }
} catch (e) {
	R.rec('SUITE', 'the bundles suite ran', 'FAIL', { error: String(e?.stack ?? e).slice(0, 4000) });
	scenarios.push({ id: 'SUITE', view: 'discovery_tab', pass: false });
} finally {
	try { b?.proc?.kill('SIGKILL'); } catch { /* gone */ }
	await A.stop().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(finish() ? 0 : 1);
