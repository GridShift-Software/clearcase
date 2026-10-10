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
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { buildCase, putOriginal, pdf, row, url } = await import('../pilot/lib/fixtures.ts');
const { appServer } = await import('../pilot/suite/context.mjs');
const { vpath } = await import('../pilot/lib/client.mjs');
const { docxText } = await import('../../../scripts/parity/lib/exports.mjs');
const { page, text, titleAndFocus, withBusyStore } = await import('./lib.mjs');

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
	const D = `${V}/bundles/discovery_tab`, C = `${V}/bundles/caselines_tab`, B = `${V}/bundles/court_bundle_tab`;
	const marks = () => A.work('SELECT case_id, locator, selected, co FROM bundles_schedule_mark ORDER BY locator');
	const chip = (fn) => `#ds-list .ds-chip[data-key$=${JSON.stringify('/' + fn)}] input[type=checkbox]`;

	// ---- Discovery Schedule -----------------------------------------------------------------------------------
	await S('DS-TITLE', 'discovery_tab', 'Discovery Schedule: document title, heading, focus on the heading after sidebar navigation', () => titleAndFocus(p, V, 'discovery_tab', 'Discovery Schedule'));
	await S('DS-SOURCE', 'discovery_tab', 'scenario 1: the schedule matches its source rows, order and counts; an unindexed file is not served; an item without files is marked (BA-10)', async () => {
		await p.go(D, 'discovery_tab');
		const r = await p.evaluate(`({ items: [...document.querySelectorAll('#ds-list tr[data-item]')].map((t) => t.querySelector('.ds-no').textContent.trim()), info: document.getElementById('ds-info').textContent.replace(/\\s+/g, ' ').trim(), notServed: document.querySelectorAll('#ds-list .not-served').length, none: document.querySelector('#ds-list .ds-none')?.textContent.trim(), unmatched: document.getElementById('ds-missing').closest('label').textContent.trim(), links: [...document.querySelectorAll('#ds-list .ds-chip a')].map((a) => a.getAttribute('href')) })`);
		return { pass: r.items.join(',') === '1.,2.,3.' && /3 items · 3 files linked · 1 not in the verified index · uncertified$/.test(r.info) && r.notServed === 1 && r.none === 'No separate document on file — see coverage note' && r.unmatched === 'Only unmatched (1)' && r.links.every((h) => h.startsWith(`${V}/doc/`)), evidence: r };
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
		const up = await p.evaluate(`(() => { const l = [...document.querySelectorAll('#cl-docs li')].find((x) => x.textContent.includes('upload.txt')); return { links: [...l.querySelectorAll('a')].map((a) => [a.textContent.trim(), a.hasAttribute('download')]), path: location.pathname }; })()`);
		const rows = A.work("SELECT count(*) n FROM register_row WHERE store = 'caselines-links'")[0].n;
		return { pass: during.value === '/DISCOVERY A/OD-003 Scan.pdf' && during.rows === 0 && rows === 2 && /^📄 OD-003 Scan\.pdf \(linked\)OpenDownloadRemove$/.test(list[0]) && /x\.pdf \(linked\)not in the verified index; not servedRemove$/.test(list[1]) && JSON.stringify(up.links) === '[["Download",true]]' && up.path === C, evidence: { during, list, up, rows } };
	});

	// ---- Court Bundle -----------------------------------------------------------------------------------------
	await S('CB-TITLE', 'court_bundle_tab', 'Court Bundle: document title, heading, focus on the heading after sidebar navigation', () => titleAndFocus(p, V, 'court_bundle_tab', 'Court Bundle'));
	await S('CB-LIST', 'court_bundle_tab', 'list view: counts, statuses, unindexed bundle PDFs named but not served, builder explicitly not available', async () => {
		await p.go(B, 'court_bundle_tab');
		const rows = await p.evaluate(`[...document.querySelectorAll('#cb-list tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join('|'))`);
		await p.click('#cb-build');
		await p.waitFor(`document.getElementById('cb-builder-state')`);
		const state = await p.text('#cb-builder-state');
		return { pass: rows.length === 2 && /^1\|Bundle AInvented\|1\|2\|complete\|Open Bundle PDF Index PDF Word$/.test(rows[0]) && /^2\|Bundle B\|1\|2\|complete\|Open Bundle PDF \(not in the verified index; not served\) Index PDF \(not in the verified index; not served\) Word$/.test(rows[1]) && /not available in this version/.test(state), evidence: { rows, state } };
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
		await p.click('#cb-save');
		await p.idle();
		await p.waitFor(`!document.getElementById('cb-error')`);
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
		await p.idle();
		const cleared = await p.evaluate(`document.getElementById('cbh_court').value + '|' + document.querySelector('#cb-header .meta b')?.textContent`);
		await p.click('#cb-restore');
		await p.idle();
		const restored = await p.evaluate(`document.getElementById('cbh_court').value`);
		const left = A.work("SELECT count(*) n FROM register_row WHERE store = 'bundle-header'")[0].n;
		return {
			pass: during.kept && during.rows === 0 && saved.length === 1 && JSON.parse(saved[0].fields).caseNo === '7/2001' && head.join('|') === 'SYN COURT|SYN DIVISION|CASE NUMBER: 7/2001|Between:|SYN ONE\nLINE TWOAPPLICANT|and|SYN TWORESPONDENT|INDEX|Bundle B'
				&& idx.join('\n') === '1.|[DESCRIPTION TO BE COMPLETED]|001 – 003' && doc?.name === 'Index_2_Bundle_B.docx' && dtext.split('\n').join('|') === 'SYN COURT|SYN DIVISION|CASE NUMBER: 7/2001|Between:|SYN ONE APPLICANT|LINE TWO|and|SYN TWO RESPONDENT|INDEX|Bundle B|1.|[DESCRIPTION TO BE COMPLETED]|001 – 003'
				&& cleared === '|8 fields blank — placeholders will be used.' && restored === 'Invented court' && left === 0,
			evidence: { during, head, idx, name: doc?.name, dtext, cleared, restored, left },
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
		await p.idle();
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
} catch (e) {
	R.rec('SUITE', 'the bundles suite ran', 'FAIL', { error: String(e?.stack ?? e).slice(0, 4000) });
	scenarios.push({ id: 'SUITE', view: 'discovery_tab', pass: false });
} finally {
	try { b?.proc?.kill('SIGKILL'); } catch { /* gone */ }
	await A.stop().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(finish() ? 0 : 1);
