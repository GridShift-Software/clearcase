#!/usr/bin/env bun
// Verification lane 04 (CC-09) probe: durability and concurrency of the bundle views' user work, on synthetic cases
// only. Run offline: unshare -rn env OUTER_UID=.. OUTER_GID=.. tests/e2e/pilot/offline.sh bun .local/verify/probe.mjs
process.env.CANARY_PORT ??= '43299';
const { mkdirSync, rmSync, writeFileSync, copyFileSync, readdirSync, renameSync, existsSync, statSync } = await import('node:fs');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const ROOT = resolve(import.meta.dirname, '..', '..');
const T = join(ROOT, 'tests', 'e2e');
const BUILD = join(ROOT, 'build');
const { launch, sleep } = await import(join(T, 'pilot/lib/cdp.mjs'));
const { buildCase, pdf, row, url } = await import(join(T, 'pilot/lib/fixtures.ts'));
const { appServer } = await import(join(T, 'pilot/suite/context.mjs'));
const { vpath } = await import(join(T, 'pilot/lib/client.mjs'));
const { startServer } = await import(join(T, 'pilot/lib/server.mjs'));
const { page } = await import(join(T, 'bundles/lib.mjs'));

const OUT = join(import.meta.dirname, 'probe-out.json');
const only = (process.env.PROBE_ONLY ?? '').split(',').filter(Boolean);
const tmp = join(import.meta.dirname, 'tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const results = [];
const rec = (id, pass, evidence) => { results.push({ id, pass, evidence }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(evidence).slice(0, 1500)}`); };
const run = async (id, fn) => {
	if (only.length && !only.includes(id)) return;
	try { const r = await fn(); rec(id, r.pass, r.evidence ?? r); } catch (e) { rec(id, false, { error: String(e?.stack ?? e).slice(0, 1500) }); }
};

const edit = (r) => {
	r.SCHED.discovery.push(
		{ no: 2, date: '04/02/2001', desc: 'Invented two-file item', co: 'C', nfiles: 2, files: [{ fn: 'OD-002 Invoice 1001.pdf', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf'), co: 'C' }, { fn: 'Not indexed.pdf', url: url('NOT INDEXED/Not indexed.pdf'), co: 'C' }] },
		{ no: 3, date: '', desc: 'Invented unmatched item', co: 'C', nfiles: 0, files: [] },
	);
	r.CASELINES.index = [[1, 'Invented page one about the court'], [2, '   '], [3, 'Court again and court once more']];
	r.CASELINES.pages = 3;
};
const mk = (dir, caseId) => buildCase(join(tmp, dir), {
	caseId,
	originals: { 'INVENTED FOLDER/INVENTED BUNDLE.pdf': pdf('invented pleadings original') },
	rows: [row('PN-001', 900, 'INVENTED FOLDER/INVENTED BUNDLE.pdf', pdf('invented pleadings original').length, { bundle: 'Pleadings' })],
	edit,
});
const ca = await mk('case-a', 'e2e-case');
const cb = await mk('case-b', 'e2e-case-b');
const A = appServer({ name: 'a', root: ROOT, buildDir: BUILD, port: 43100, origPort: 43101, dir: tmp });
const start = async () => { A.srv = await startServer({ root: ROOT, port: A.port, origPort: A.origPort, dataDir: A.dataDir, buildDir: BUILD, logFile: A.logFile }); return A.srv; };
let b;
// a manual hold on work.sqlite's write lock from outside the app (BEGIN IMMEDIATE, busy_timeout 0)
const lock = () => { const d = new Database(join(A.dataDir, 'work.sqlite')); d.exec('PRAGMA busy_timeout=0'); d.exec('BEGIN IMMEDIATE'); const t0 = Date.now(); return { t0, release() { d.exec('ROLLBACK'); d.close(); return Date.now() - t0; } }; };
const marks = (c) => A.work('SELECT case_id, locator, selected, co FROM bundles_schedule_mark WHERE case_id = ? ORDER BY locator', c);
const regs = (c, store) => A.work('SELECT row_id, fields FROM register_row WHERE case_id = ? AND store = ? ORDER BY row_id', c, store);
const snap = (q = A.work) => JSON.stringify({ marks: q('SELECT * FROM bundles_schedule_mark ORDER BY case_id, locator'), regs: q("SELECT case_id, row_id, store, fields FROM register_row WHERE store IN ('bundle-header', 'caselines-links', 'discovery-mode') ORDER BY case_id, store, row_id") });
const chip = (fn) => `#ds-list .ds-chip[data-key$=${JSON.stringify('/' + fn)}]`;
const box = (fn) => `${chip(fn)} input[type=checkbox]`;
const tag = async (p, sel, t) => p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.setAttribute('data-t', ${JSON.stringify(t)}); return true; })()`);
const coBtn = async (p, fn, v, t) => { await p.evaluate(`document.querySelector(${JSON.stringify(chip(fn))}).querySelector('button[aria-label=${v === 'O' ? 'Original' : 'Copy'}]').setAttribute('data-t', ${JSON.stringify(t)})`); return `[data-t="${t}"]`; };
const dsState = (p) => p.evaluate(`({ count: document.getElementById('ds-count')?.textContent.trim() ?? null, mode: document.querySelector('#main .ds-switch button.on')?.dataset.mode ?? null, checked: [...document.querySelectorAll('#ds-list .ds-chip')].filter((c) => c.querySelector('input[type=checkbox]').checked).map((c) => c.querySelector('.fn').textContent), O: [...document.querySelectorAll('#ds-list .ds-chip')].filter((c) => c.querySelector('button.on-o')).map((c) => c.querySelector('.fn').textContent), error: document.getElementById('ds-error')?.textContent.trim() ?? null, pending: document.getElementById('main')?.dataset.pending })`);
const setField = (p, id, v) => p.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const val = (p, id) => p.evaluate(`document.getElementById(${JSON.stringify(id)})?.value ?? null`);
const toMode = async (p, m) => { if ((await dsState(p)).mode !== m) { await p.click(`#main .ds-switch button[data-mode="${m}"]`); await p.idle(); } };

try {
	await start();
	for (const c of [ca, cb]) {
		const imp = await A.c.importPkg(c.caseDir, c.pkgDir);
		const act = await A.c.activate(imp.importId);
		if (!imp.importId || act.status >= 400) throw new Error(`import/activate failed: ${JSON.stringify({ imp: imp.status, act: act.status })}`);
	}
	const VA = vpath(ca.resultsVersion), VB = vpath(cb.resultsVersion);
	const D = (v) => `${v}/bundles/discovery_tab`, C = (v) => `${v}/bundles/caselines_tab`, B = (v) => `${v}/bundles/court_bundle_tab`;
	b = await launch({ profileRoot: join(tmp, 'profile') });
	const p = await page(b, A.origin);
	const p2 = await page(b, A.origin);

	// ---- per case and reload ----------------------------------------------------------------------------------
	await run('V4-PERCASE-RELOAD', async () => {
		await p.go(D(VA), 'discovery_tab');
		await p.click(box('OD-001 Supply agreement.pdf')); await p.idle();
		await p.click(await coBtn(p, 'OD-001 Supply agreement.pdf', 'O', 'o1')); await p.idle();
		await toMode(p, 'supplementary');
		await p.go(B(VA), 'court_bundle_tab');
		const defCaseNo = await val(p, 'cbh_caseNo');
		await setField(p, 'cbh_caseNo', 'V4-A-CASENO');
		await p.click('#cb-save'); await p.idle();
		await p.go(C(VA), 'caselines_tab');
		await p.type('#cl-path', 'DISCOVERY A/OD-003 Scan.pdf');
		await p.click('#cl-link');
		await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length === 1`);
		// reload each A view
		await p.go(D(VA), 'discovery_tab');
		const dA = await dsState(p);
		await toMode(p, 'discovery');
		const dA2 = await dsState(p);
		await toMode(p, 'supplementary');
		await p.go(B(VA), 'court_bundle_tab');
		const hA = await val(p, 'cbh_caseNo');
		await p.go(C(VA), 'caselines_tab');
		const lA = await p.count('#cl-docs li[data-row]');
		// case B sees none of it
		await p.go(D(VB), 'discovery_tab');
		const dB = await dsState(p);
		await p.go(B(VB), 'court_bundle_tab');
		const hB = await val(p, 'cbh_caseNo');
		await p.go(C(VB), 'caselines_tab');
		const lB = await p.count('#cl-docs li[data-row]');
		const mA = marks('e2e-case'), mB = marks('e2e-case-b');
		const ev = { dA: { count: dA.count, mode: dA.mode }, dA2: { checked: dA2.checked, O: dA2.O }, hA, lA, dB: { count: dB.count, mode: dB.mode, checked: dB.checked, O: dB.O }, hB, defCaseNo, lB, mA: mA.length, mB: mB.length, regsB: ['bundle-header', 'caselines-links', 'discovery-mode'].map((s) => regs('e2e-case-b', s).length) };
		return { pass: dA.count === '1' && dA.mode === 'supplementary' && dA2.checked.join() === 'OD-001 Supply agreement.pdf' && dA2.O.join() === 'OD-001 Supply agreement.pdf' && hA === 'V4-A-CASENO' && lA === 1 && dB.count === '0' && dB.mode === 'discovery' && dB.checked.length === 0 && dB.O.length === 0 && hB === defCaseNo && lB === 0 && mA.length === 1 && mB.length === 0 && ev.regsB.every((n) => n === 0), evidence: ev };
	});

	// ---- SIGKILL right after the response, then a graceful restart --------------------------------------------
	await run('V4-SIGKILL-NOWAIT', async () => {
		await p.go(D(VA), 'discovery_tab');
		await toMode(p, 'supplementary');
		await p.click(box('SD-001 Statement.pdf')); await p.idle();
		await p.go(B(VA), 'court_bundle_tab');
		await setField(p, 'cbh_judge', 'V4-JUDGE');
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('main').dataset.busy === '0' && !document.getElementById('cb-error')`, 30000);
		const s0 = snap();
		const k = await A.srv.stop('SIGKILL'); A.srv = null;
		await start();
		const s1 = snap();
		await p.go(D(VA), 'discovery_tab');
		const d1 = await dsState(p);
		await p.go(B(VA), 'court_bundle_tab');
		const j1 = await val(p, 'cbh_judge'), c1 = await val(p, 'cbh_caseNo');
		const g = await A.stop();
		await start();
		const s2 = snap();
		await p.go(C(VA), 'caselines_tab');
		const l2 = await p.count('#cl-docs li[data-row]');
		return { pass: k.exit?.sig === 'SIGKILL' && g.exit?.sig !== 'SIGKILL' && g.graceful && s0 === s1 && s1 === s2 && d1.count === '2' && d1.mode === 'supplementary' && j1 === 'V4-JUDGE' && c1 === 'V4-A-CASENO' && l2 === 1, evidence: { killExit: k.exit, stopExit: g.exit, stopGraceful: g.graceful, same: [s0 === s1, s1 === s2], d1: { count: d1.count, mode: d1.mode }, j1, c1, l2 } };
	});

	// ---- the work.sqlite backup holds the rows, and restoring it brings them back --------------------------------
	let saved = null;
	await run('V4-BACKUP-RESTORE', async () => {
		await p.go(D(VA), 'discovery_tab');
		await p.click(box('SD-001 Statement.pdf')); await p.idle(); // unselect
		await p.click(box('SD-001 Statement.pdf')); await p.idle(); // select again: a fresh write
		await sleep(4500); // > userWorkBackupDelayMs (3000)
		const dir = join(A.dataDir, 'backups');
		const files = readdirSync(dir).filter((n) => /^work-\d{10}-.*\.sqlite$/.test(n)).sort();
		const newest = files.at(-1);
		saved = join(tmp, 'saved-backup.sqlite');
		copyFileSync(join(dir, newest), saved);
		const bd = new Database(saved, { readonly: true });
		const bq = (sql, ...a) => bd.query(sql).all(...a);
		const catalog = bq("SELECT name, kind, owner FROM userwork_catalog WHERE name = 'bundles_schedule_mark'");
		const sb = snap(bq), live = snap();
		bd.close();
		// change everything, then stop gracefully (that writes another backup)
		await p.click('#ds-clear'); await p.idle();
		await toMode(p, 'discovery');
		await p.go(B(VA), 'court_bundle_tab');
		await p.click('#cb-clear'); await p.waitFor(`document.getElementById('cbh_court').value === '' && document.getElementById('main').dataset.busy === '0'`, 30000);
		await p.go(C(VA), 'caselines_tab');
		await p.evaluate(`document.querySelector('#cl-docs li[data-row] button.rm').setAttribute('data-t', 'rm')`);
		await p.click('[data-t="rm"]');
		await p.waitFor(`document.querySelectorAll('#cl-docs li[data-row]').length === 0`, 30000);
		const changed = snap();
		await A.stop();
		// the documented restore: move work.sqlite and its sidecars away, copy the backup in, start
		mkdirSync(join(tmp, 'moved'), { recursive: true });
		for (const n of ['work.sqlite', 'work.sqlite-journal', 'work.sqlite-wal', 'work.sqlite-shm']) if (existsSync(join(A.dataDir, n))) renameSync(join(A.dataDir, n), join(tmp, 'moved', n));
		copyFileSync(saved, join(A.dataDir, 'work.sqlite'));
		await start();
		const restored = snap();
		await p.go(D(VA), 'discovery_tab');
		const d = await dsState(p);
		await p.go(B(VA), 'court_bundle_tab');
		const h = { caseNo: await val(p, 'cbh_caseNo'), judge: await val(p, 'cbh_judge') };
		await p.go(C(VA), 'caselines_tab');
		const l = await p.count('#cl-docs li[data-row]');
		const nb = JSON.parse(sb);
		return { pass: sb === live && changed !== live && restored === sb && catalog.length === 1 && catalog[0].kind === 'user-work' && catalog[0].owner === 'GRS-19' && d.count === '2' && d.mode === 'supplementary' && h.caseNo === 'V4-A-CASENO' && h.judge === 'V4-JUDGE' && l === 1,
			evidence: { backups: files.length, backupEqualsLive: sb === live, backupRows: { marks: nb.marks.length, regs: nb.regs.length }, catalog, changedDiffers: changed !== live, restoredEqualsBackup: restored === sb, ui: { count: d.count, mode: d.mode, ...h, links: l } } };
	});

	// ---- repeated failures, then success: Discovery --------------------------------------------------------------
	await run('V4-DS-REPEAT-FAIL', async () => {
		await p.go(D(VA), 'discovery_tab');
		await toMode(p, 'discovery');
		const before = marks('e2e-case');
		const L = lock();
		const t = {};
		await p.click(box('OD-002 Invoice 1001.pdf'));
		await p.waitFor(`document.getElementById('ds-error')`, 45000);
		t.firstError = Date.now() - L.t0;
		const s1 = await dsState(p);
		await p.click('#ds-retry');
		await p.waitFor(`!document.getElementById('ds-error')`, 5000);
		await p.waitFor(`document.getElementById('ds-error')`, 45000);
		t.secondError = Date.now() - L.t0;
		const s2 = await dsState(p);
		await p.click(box('Not indexed.pdf'));
		await sleep(400);
		const s3 = await dsState(p);
		const rowsLocked = marks('e2e-case');
		t.released = L.release();
		// after the release, another change without Retry: it must not hide the pending failures
		await p.click(box('OD-001 Supply agreement.pdf')); // unselect
		await sleep(1500);
		const s4 = await dsState(p);
		await p.click('#ds-retry');
		await p.idle();
		const s5 = await dsState(p);
		const after = marks('e2e-case');
		await p.go(D(VA), 'discovery_tab');
		await toMode(p, 'discovery');
		const s6 = await dsState(p);
		const sel = (rows, end) => rows.filter((r) => r.locator.endsWith(end)).map((r) => `${r.selected}${r.co ?? '-'}`).join();
		const ev = { t, s1: { err: !!s1.error, checked: s1.checked }, s2: { err: !!s2.error, checked: s2.checked }, s3: { err: !!s3.error, checked: s3.checked }, s4: { err: s4.error, checked: s4.checked }, s5: { err: s5.error, checked: s5.checked }, s6: { checked: s6.checked }, rowsUnchangedWhileLocked: JSON.stringify(rowsLocked) === JSON.stringify(before), after: { od002: sel(after, 'OD-002 Invoice 1001.pdf'), notIndexed: sel(after, 'Not indexed.pdf'), od001: sel(after, 'OD-001 Supply agreement.pdf') } };
		const want = ['OD-002 Invoice 1001.pdf', 'Not indexed.pdf'];
		return { pass: !!s1.error && s1.checked.includes(want[0]) && !!s2.error && s2.checked.includes(want[0]) && !!s3.error && s3.checked.includes(want[1]) && !!s4.error && !s4.checked.includes('OD-001 Supply agreement.pdf') && !s5.error && ev.rowsUnchangedWhileLocked && ev.after.od002 === '1-' && ev.after.notIndexed === '1-' && ev.after.od001 === '0O' && s6.checked.sort().join() === [...want].sort().join(), evidence: ev };
	});

	// ---- repeated failures, then success: Court Bundle header --------------------------------------------------
	await run('V4-CB-REPEAT-FAIL', async () => {
		await p.go(B(VA), 'court_bundle_tab');
		await setField(p, 'cbh_court', 'RF COURT');
		await setField(p, 'cbh_caseNo', 'RF-1');
		const before = JSON.stringify(regs('e2e-case', 'bundle-header'));
		const L = lock();
		const t = {};
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('cb-error') && document.getElementById('main').dataset.busy === '0'`, 45000);
		t.first = Date.now() - L.t0;
		const k1 = [await val(p, 'cbh_court'), await val(p, 'cbh_caseNo')];
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('main').dataset.busy === '1'`, 5000);
		await p.waitFor(`document.getElementById('cb-error') && document.getElementById('main').dataset.busy === '0'`, 45000);
		t.second = Date.now() - L.t0;
		const k2 = [await val(p, 'cbh_court'), await val(p, 'cbh_caseNo')];
		const rowsLocked = JSON.stringify(regs('e2e-case', 'bundle-header'));
		t.released = L.release();
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('main').dataset.busy === '0' && !document.getElementById('cb-error')`, 30000);
		const r = regs('e2e-case', 'bundle-header');
		await p.go(B(VA), 'court_bundle_tab');
		const k3 = [await val(p, 'cbh_court'), await val(p, 'cbh_caseNo')];
		const f = r.length === 1 ? JSON.parse(r[0].fields) : {};
		return { pass: k1.join() === 'RF COURT,RF-1' && k2.join() === 'RF COURT,RF-1' && rowsLocked === before && r.length === 1 && f.court === 'RF COURT' && f.caseNo === 'RF-1' && k3.join() === 'RF COURT,RF-1', evidence: { t, k1, k2, unchangedWhileLocked: rowsLocked === before, rows: r.length, k3 } };
	});

	// ---- repeated failures, then success: CaseLines link --------------------------------------------------------
	await run('V4-CL-REPEAT-FAIL', async () => {
		await p.go(C(VA), 'caselines_tab');
		const n0 = regs('e2e-case', 'caselines-links').length;
		await p.type('#cl-path', 'RF FOLDER/RF.pdf');
		const L = lock();
		await p.click('#cl-link');
		await p.waitFor(`document.getElementById('cl-error') && document.getElementById('main').dataset.busy === '0'`, 45000);
		const v1 = await val(p, 'cl-path');
		await p.click('#cl-link');
		await p.waitFor(`document.getElementById('main').dataset.busy === '1'`, 5000);
		await p.waitFor(`document.getElementById('cl-error') && document.getElementById('main').dataset.busy === '0'`, 45000);
		const v2 = await val(p, 'cl-path');
		const nLocked = regs('e2e-case', 'caselines-links').length;
		L.release();
		await p.click('#cl-link');
		await p.waitFor(`document.getElementById('main').dataset.busy === '0' && !document.getElementById('cl-error') && document.getElementById('cl-path').value === ''`, 30000);
		const n1 = regs('e2e-case', 'caselines-links').length;
		await p.go(C(VA), 'caselines_tab');
		const shown = await p.evaluate(`[...document.querySelectorAll('#cl-docs li[data-row]')].map((l) => l.querySelector('.nm').textContent.trim())`);
		return { pass: v1 === 'RF FOLDER/RF.pdf' && v2 === v1 && nLocked === n0 && n1 === n0 + 1 && shown.some((s) => s.includes('RF.pdf')), evidence: { v1, v2, n0, nLocked, n1, shown } };
	});

	// ---- typing while a header save is pending (the store is busy for a few seconds, then frees) ---------------
	await run('V4-CB-INFLIGHT-TYPING', async () => {
		await p.go(B(VA), 'court_bundle_tab');
		await setField(p, 'cbh_court', 'IF COURT');
		const L = lock();
		await p.click('#cb-save');
		await p.waitFor(`document.getElementById('main').dataset.busy === '1'`, 5000);
		await sleep(800);
		await p.type('#cbh_judge', 'IF JUDGE TYPED WHILE SAVING');
		const typed = await val(p, 'cbh_judge');
		await sleep(1500);
		const held = L.release();
		await p.waitFor(`document.getElementById('main').dataset.busy === '0'`, 45000);
		await sleep(300);
		const after = { judge: await val(p, 'cbh_judge'), court: await val(p, 'cbh_court'), error: await p.text('#cb-error'), blankNote: await p.text('#cb-header .meta b') };
		const r = regs('e2e-case', 'bundle-header');
		const f = r.length ? JSON.parse(r[0].fields) : {};
		return { pass: after.judge === typed || f.judge === typed, evidence: { held, typed, after, stored: { court: f.court, judgeIsTyped: f.judge === typed } } };
	});

	// ---- two tabs, same file: plain, then while the store is locked ---------------------------------------------
	await run('V4-TWOTABS-PLAIN', async () => {
		await p.go(D(VA), 'discovery_tab'); await toMode(p, 'discovery');
		await p.click('#ds-clear'); await p.idle();
		await p.go(D(VA), 'discovery_tab');
		await p2.go(D(VA), 'discovery_tab');
		const W = 'Not indexed.pdf';
		await p.click(box(W)); await p.idle();
		await p2.click(await coBtn(p2, W, 'O', 'p2o')); await p2.idle();
		const row = marks('e2e-case').filter((r) => r.locator.endsWith(W)).map((r) => `${r.selected}${r.co ?? '-'}`).join();
		return { pass: row === '1O', evidence: { row } };
	});
	await run('V4-TWOTABS-LOCKED', async () => {
		await p.go(D(VA), 'discovery_tab'); await toMode(p, 'discovery');
		await p.click('#ds-clear'); await p.idle();
		const W = 'OD-002 Invoice 1001.pdf';
		// make W free of marks: the C/O mark cannot be removed in the UI, so pick W only if it has none
		const pre = marks('e2e-case').filter((r) => r.locator.endsWith(W));
		await p.go(D(VA), 'discovery_tab');
		await p2.go(D(VA), 'discovery_tab');
		const L = lock();
		await p.click(box(W)); // tab 1: select W
		await sleep(1200);
		await p2.click(await coBtn(p2, W, 'O', 'p2o2')); // tab 2: mark W Original
		await sleep(7000);
		const held = L.release();
		await p.idle(); await p2.idle();
		await sleep(300);
		const e1 = await dsState(p), e2 = await dsState(p2);
		const row = marks('e2e-case').filter((r) => r.locator.endsWith(W)).map((r) => `${r.selected}${r.co ?? '-'}`).join();
		await p.go(D(VA), 'discovery_tab');
		const r1 = await dsState(p);
		const ev = { pre, held, tab1: { error: e1.error, showsSelected: e1.checked.includes(W) }, tab2: { error: e2.error, showsO: e2.O.includes(W) }, stored: row, afterReload: { selected: r1.checked.includes(W), O: r1.O.includes(W) } };
		return { pass: row === '1O' && r1.checked.includes(W) && r1.O.includes(W), evidence: ev };
	});
	await run('V4-TWOTABS-HEADER', async () => {
		await p.go(B(VA), 'court_bundle_tab');
		await p2.go(B(VA), 'court_bundle_tab');
		await setField(p, 'cbh_court', 'TAB ONE COURT');
		await p.click('#cb-save'); await p.waitFor(`document.getElementById('main').dataset.busy === '0' && !document.getElementById('cb-error')`, 30000);
		await setField(p2, 'cbh_judge', 'TAB TWO JUDGE');
		await p2.click('#cb-save'); await p2.waitFor(`document.getElementById('main').dataset.busy === '0' && !document.getElementById('cb-error')`, 30000);
		const f = JSON.parse(regs('e2e-case', 'bundle-header')[0].fields);
		// informational: v5 also saves all eight fields at once (last writer wins)
		return { pass: true, evidence: { court: f.court, judge: f.judge, tabOneCourtKept: f.court === 'TAB ONE COURT', warned: false } };
	});

	// ---- two tabs link the same moment while the store is locked: seq ---------------------------------------------
	await run('V4-CL-TWOTABS-SEQ', async () => {
		await p.go(C(VA), 'caselines_tab');
		await p2.go(C(VA), 'caselines_tab');
		await p.type('#cl-path', 'SEQ/first.pdf');
		await p2.type('#cl-path', 'SEQ/second.pdf');
		const L = lock();
		await p.click('#cl-link');
		await sleep(1200);
		await p2.click('#cl-link');
		await sleep(7000);
		L.release();
		await p.waitFor(`document.getElementById('main').dataset.busy === '0'`, 45000);
		await p2.waitFor(`document.getElementById('main').dataset.busy === '0'`, 45000);
		const rows = regs('e2e-case', 'caselines-links').map((r) => JSON.parse(r.fields)).filter((f) => String(f.path).startsWith('SEQ/'));
		await p.go(C(VA), 'caselines_tab');
		const shown = await p.evaluate(`[...document.querySelectorAll('#cl-docs li[data-row]')].map((l) => l.querySelector('.nm').textContent.trim()).filter((t) => /first|second/.test(t))`);
		const seqs = rows.map((r) => r.seq);
		return { pass: rows.length === 2 && new Set(seqs).size === 2, evidence: { rows: rows.map((r) => `${r.path}#${r.seq}`), shown } };
	});

	// ---- the first Discovery load after a start while the store is locked --------------------------------------
	await run('V4-LOCKED-FIRST-LOAD', async () => {
		await A.stop();
		await start();
		const L = lock();
		const get = async (path) => { const t0 = Date.now(); const r = await fetch(A.origin + path).catch((e) => ({ status: 'err ' + e.message, text: async () => '' })); const body = await r.text(); return { status: r.status, ms: Date.now() - t0, ready: /data-ready="(discovery_tab|court_bundle_tab|caselines_tab)"/.exec(body)?.[1] ?? null }; };
		const cbl = await get(B(VA));
		const ds = await get(D(VA));
		const held = L.release();
		const ds2 = await get(D(VA));
		return { pass: ds.status === 200 && ds.ready === 'discovery_tab', evidence: { courtBundleWhileLocked: cbl, discoveryWhileLocked: ds, held, discoveryAfterRelease: ds2 } };
	});
} catch (e) {
	rec('PROBE', false, { error: String(e?.stack ?? e).slice(0, 3000) });
} finally {
	try { b?.proc?.kill('SIGKILL'); } catch { /* gone */ }
	await A.stop().catch(() => {});
	writeFileSync(OUT, JSON.stringify(results, null, 1));
	if (!process.env.PROBE_KEEP) rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
