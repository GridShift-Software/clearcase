#!/usr/bin/env bun
// Offline browser suite of the system views (GRS-20, CC-10), run by `bun run --bun test:e2e` in its own network
// namespace. It starts the production entry (bun scripts/pilot/start.ts) on ./build with a fresh data directory and the
// parity clock, imports and activates a synthetic case (tests/e2e/pilot/lib/fixtures.ts), and drives Rescan & Update,
// Backup / Restore, Manual and the overview's Freshness slot through Chromium: a repeat scan, same-prefix additions,
// a same-size change, a removed original, the index file, a backup round trip, refused restores (data unchanged), a
// restore into a fresh profile, the manual's lists, and the bug classes (no JavaScript, typing during an in-flight
// restore, a 64-character case id at 320 and 390 px, focus after Back). Synthetic data only. Results:
// $CLEARCASE_E2E_OUT/system/<scenario>.json and summary.json ({scenarios: [{id, view, pass}]}). Exit 0 only when
// every scenario passed.
process.env.CANARY_PORT ??= '43799';
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { readFile, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { INIT, openPage } = await import('../pilot/suite/browser.mjs');
const { appServer, vpath } = await import('../pilot/suite/context.mjs');
const { startServer } = await import('../pilot/lib/server.mjs');
const { buildCase, putOriginal } = await import('../pilot/lib/fixtures.ts');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = join(ROOT, 'build');
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'system');
mkdirSync(OUT, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
const J = JSON.stringify;
const SYSTEM_VIEWS = ['rescan_tab', 'backup_tab', 'manual'];
const LABEL = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));
const CASE_ID = 'e2e-system';

const results = [];
async function scenario(id, view, title, fn) {
	const t0 = Date.now();
	let pass = false, evidence = {};
	try {
		const r = await fn();
		evidence = r;
		pass = Object.values(r.checks ?? {}).length > 0 && Object.values(r.checks).every((x) => x === true);
	} catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	results.push({ id, view, pass });
	writeFileSync(join(OUT, `${id}.json`), J({ id, view, title, pass, ms: Date.now() - t0, ...evidence }, null, 1));
	console.log(`${pass ? 'PASS' : 'FAIL'}    ${id} [${view}] ${title}`);
	return pass;
}

let p, A, B, rv, tmp, b, sc;
const ready = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)}`;
const hydrated = (view) => `${ready(view)} && !!document.querySelector('main#main[data-hydrated]')`;
const openView = (view, server = A, version = rv, query = '') => p.goto(`${server.origin}${vpath(version)}/system/${view}${query}`, hydrated(view));
const text = (sel) => p.evaluate(`document.querySelector(${J(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
const addedRefs = () => p.evaluate(`[...document.querySelectorAll('#rescan-added tbody tr')].map((r) => r.dataset.ref)`);
const tableRows = (sel) => p.evaluate(`[...document.querySelectorAll(${J(`${sel} tbody tr`)})].map((r) => [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()))`);
/** Every row of every table of work.sqlite, so a refused restore can be shown to change nothing. */
const workDump = (server = A) => Object.fromEntries(server.work("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(({ name }) => [name, server.work(`SELECT * FROM "${name.replace(/"/g, '""')}"`)]));
const fetchText = (sel) => p.evaluate(`fetch(document.querySelector(${J(sel)}).href).then(async (r) => ({ status: r.status, disposition: r.headers.get('content-disposition'), text: await r.text() }))`);
/** Hold work.sqlite's write lock from outside the app (another process), as a busy store. */
const hold = (server = A) => { const l = new Database(join(server.dataDir, 'work.sqlite')); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); let held = true; return () => { if (held) { held = false; l.exec('ROLLBACK'); l.close(); } }; };

async function scan(mode = 'quick') {
	// the fixed clock gives every run the same time, so wait for the busy status to come and go rather than for new text
	await p.evaluate(`(() => { window.__busySeen = false; const o = new MutationObserver(() => { if (document.getElementById('scan-busy')) { window.__busySeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
	await p.click(mode === 'full' ? '#rescan-full' : '#rescan-now');
	await p.waitFor(`window.__busySeen && !document.getElementById('scan-busy') && !document.querySelector('#scan-form fieldset').disabled`, 30000);
	await sleep(50);
}
async function setFile(sel, file) {
	const { root } = await p.s('DOM.getDocument', { depth: 0 });
	const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
	await p.s('DOM.setFileInputFiles', { nodeId, files: [file] });
}
/** Restore through the page (JavaScript on): a file upload, or a typed path when `file` is null. */
async function restore({ file = null, path = null } = {}) {
	await p.evaluate(`(() => { for (const id of ['restore-done', 'restore-error', 'restore-legacy']) document.getElementById(id)?.remove(); return true; })()`);
	if (file) await setFile('#restore-file', file);
	if (path !== null) await p.type('#restore-path', path);
	await p.evaluate(`document.getElementById('restore-confirm').checked = true`);
	await p.click('#restore-submit');
	await p.waitFor(`!document.getElementById('restore-busy') && !!(document.getElementById('restore-done') || document.getElementById('restore-error') || document.getElementById('restore-legacy'))`, 30000);
	return p.evaluate(`({ done: document.getElementById('restore-done')?.textContent.trim() ?? null, error: document.getElementById('restore-error')?.textContent.trim() ?? null, code: document.getElementById('restore-error')?.dataset.code ?? null, legacy: document.getElementById('restore-legacy')?.textContent.replace(/\\s+/g, ' ').trim() ?? null })`);
}

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
writeFileSync(join(OUT, 'offline.json'), J(offline, null, 1));
if (!offline.pass) { console.error('system suite: not offline'); writeFileSync(join(OUT, 'summary.json'), J({ ok: false, offline: false, scenarios: [] })); process.exit(1); }
tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-system-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
let ok = false;
const server = (name, port) => {
	const s = appServer({ name, root: ROOT, buildDir: BUILD, port, origPort: port + 1, dir: tmp });
	s.start = async () => { s.srv = await startServer({ root: ROOT, port: s.port, origPort: s.origPort, dataDir: s.dataDir, buildDir: BUILD, logFile: s.logFile, env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } }); return s.srv; };
	return s;
};
try {
	A = server('system', 43700);
	await A.start();
	sc = await buildCase(join(tmp, 'case'), { caseId: CASE_ID });
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	await A.c.activate(imp.importId);
	rv = await A.c.activeVersion();
	if (rv !== sc.resultsVersion) throw new Error(`activation failed: ${J({ status: imp.status, id: imp.importId })}`);
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: INIT });

	// 1. Each view opened from the navigation: title, focused heading, current entry, no unavailable state.
	for (const view of SYSTEM_VIEWS) {
		await scenario(`SY1-${view}`, view, 'opened from the navigation: document title, heading focused, current entry', async () => {
			await p.goto(`${A.origin}${vpath(rv)}/overview`, ready('overview'));
			await p.click(`#nav-${view}`);
			await p.waitFor(hydrated(view), 20000);
			await sleep(80);
			const s = await p.evaluate(`({ title: document.title, h1: document.querySelector('[data-page-heading]')?.textContent.trim(), focused: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('a[data-view][aria-current="page"]')?.id ?? null })`);
			return { evidence: s, checks: { heading: s.h1 === LABEL[view], title: s.title.startsWith(`${LABEL[view]} · `), focus: s.focused, current: s.current === `nav-${view}` } };
		});
	}

	// 2. Rescan: an unchanged folder twice, then same-prefix additions, idempotent, published to the document lists.
	let refs = [];
	await scenario('SY2-rescan-additions', 'rescan_tab', 'an unchanged folder scanned twice adds nothing and is never called current by a quick scan; three same-prefix additions get distinct refs that a repeat scan keeps; the index file and the Freshness stamp count them', async () => {
		await openView('rescan_tab');
		await scan();
		const first = { status: await text('#rescan-status'), verdict: await text('#rescan-verdict'), current: await p.evaluate(`document.getElementById('rescan-status').dataset.current`), };
		await scan();
		const second = { status: await text('#rescan-status') };
		await putOriginal(sc.caseDir, 'DISCOVERY A/OD-005 Letter.pdf', new TextEncoder().encode('%PDF-1.4 synthetic a'));
		await putOriginal(sc.caseDir, 'DISCOVERY A/OD-005 Letter copy.pdf', new TextEncoder().encode('%PDF-1.4 synthetic b'));
		await putOriginal(sc.caseDir, 'DISCOVERY A/Extra 2001-03-04.pdf', new TextEncoder().encode('%PDF-1.4 synthetic c'));
		await scan();
		refs = await addedRefs();
		const statusAdded = await text('#rescan-status');
		await scan();
		const again = await addedRefs();
		const statusAgain = await text('#rescan-status');
		await scan('full');
		const full = { verdict: await text('#rescan-verdict'), current: await p.evaluate(`document.getElementById('rescan-status').dataset.current`) };
		const index = await fetchText('#rescan-index');
		const rows = JSON.parse(index.text);
		const exportName = await p.evaluate(`({ download: document.getElementById('rescan-index')?.getAttribute('download') ?? null, note: document.querySelector('[data-export-note]')?.textContent.trim() ?? null })`);
		await p.goto(`${A.origin}${vpath(rv)}/overview`, ready('overview'));
		const stamp = await text('#freshness-stamp');
		const slot = await p.evaluate(`document.querySelector('[data-slot="rescan-freshness"]')?.dataset.slotStatus ?? null`);
		const docs = await p.evaluate(`document.getElementById('count-documents')?.dataset.count ?? null`);
		return { evidence: { first, second, refs, statusAdded, again, statusAgain, full, exportName, index: { status: index.status, disposition: index.disposition, refs: rows.map((r) => r.ref) }, stamp, slot, docs },
			checks: { unchanged: /^New: 0 · Already indexed: 7 · Total scanned: 7/.test(first.status ?? '') && first.status === second.status, quickNotCurrent: first.current === 'false' && /not compared/.test(first.verdict ?? ''),
				distinct: refs.length === 3 && J([...refs].sort()) === J(['OD-005', 'OD-006', 'OD-007']), idempotent: J(again) === J(refs) && statusAgain === statusAdded,
				fullNotCurrentWithAdditions: full.current === 'false', index: index.status === 200 && /filename="rescan-additions\.json"/.test(index.disposition ?? '') && exportName.download === 'rescan-additions.json' && /view-content|results package/.test(exportName.note ?? '') && J(rows.map((r) => r.ref).sort()) === J([...refs].sort()),
				stamp: slot === 'filled' && / · 10 documents indexed · \+3 via rescan$/.test((stamp ?? '').replace(/\.$/, '')), overviewCount: docs === '10' } };
	});

	await scenario('SY3-rescan-changes', 'rescan_tab', 'a same-name, same-size change is found by a full scan only; a removed original is reported by ref; additions stay pending processing; both are cleared when the files are back', async () => {
		const od1 = join(sc.caseDir, 'DISCOVERY A/OD-001 Supply agreement.pdf');
		const od3 = join(sc.caseDir, 'DISCOVERY A/OD-003 Scan.pdf');
		const keep1 = await readFile(od1), keep3 = await readFile(od3);
		const flipped = Buffer.from(keep1); flipped[flipped.length - 2] ^= 1;
		await writeFile(od1, flipped);
		await rm(od3);
		await openView('rescan_tab');
		await scan();
		const quick = await tableRows('#rescan-changed');
		await scan('full');
		const full = await tableRows('#rescan-changed');
		const status = (await tableRows('#rescan-added')).map((r) => r[5]);
		await writeFile(od1, keep1);
		await writeFile(od3, keep3);
		await scan('full');
		const after = await tableRows('#rescan-changed');
		return { evidence: { quick, full, status, after },
			checks: { quickMissesSameSize: J(quick) === J([['OD-003', 'DISCOVERY A/OD-003 Scan.pdf', 'Removed from the case folder']]),
				fullFinds: J(full) === J([['OD-001', 'DISCOVERY A/OD-001 Supply agreement.pdf', 'Changed (content differs, same size)'], ['OD-003', 'DISCOVERY A/OD-003 Scan.pdf', 'Removed from the case folder']]),
				pending: status.length === 3 && status.every((s) => s === 'pending processing'), cleared: after.length === 0 } };
	});

	// 3. Backup / Restore.
	const backupPath = join(tmp, 'backup.json');
	let backup;
	await scenario('SY4-backup-roundtrip', 'backup_tab', 'Export all state downloads one case file that says binaries are not included; after the additions are cleared, Import state restores them with the same refs', async () => {
		await openView('backup_tab');
		const shown = await tableRows('#backup-tables');
		const binaries = await text('#backup-binaries');
		const dl = await fetchText('#backup-export');
		writeFileSync(backupPath, dl.text);
		backup = JSON.parse(dl.text);
		await openView('rescan_tab');
		await p.evaluate(`document.getElementById('clear-confirm').checked = true`);
		await p.click('#rescan-clear');
		await p.waitFor(`!!document.getElementById('rescan-cleared')`, 20000);
		const cleared = await addedRefs();
		await openView('backup_tab');
		const r = await restore({ file: backupPath });
		await openView('rescan_tab');
		const back = await addedRefs();
		return { evidence: { shown, binaries, disposition: dl.disposition, counts: backup.counts, cleared, r, back },
			checks: { file: backup.format === 'clearcase.backup/1' && backup.binaries === false && backup.case.caseId === CASE_ID && backup.case.resultsVersion === rv && typeof backup.sha256 === 'string',
				name: /filename="clearcase-backup-e2e-system-\d{8}-\d{4}\.json"/.test(dl.disposition ?? ''), shown: shown.some((x) => x[0] === 'rescan_file' && x[2] === '3'), said: /^Binaries are not included\./.test(binaries ?? ''),
				carried: backup.counts.rescan_file === 3 && backup.counts.rescan_run === 1 && !('trusted_warning' in backup.counts), cleared: cleared.length === 0, restored: /^Restored /.test(r.done ?? '') && J(back) === J(refs) } };
	});

	await scenario('SY5-refused-restores', 'backup_tab', 'a truncated, an altered, another case\'s and a too-large backup are each refused with their reason and change nothing in work.sqlite; a v5 browser backup is recognised, its keys listed (the four legacy keys too) and nothing changed', async () => {
		const files = {
			truncated: dlText().slice(0, 200),
			altered: J({ ...backup, userWork: { ...backup.userWork, tables: backup.userWork.tables.map((t) => (t.name === 'rescan_file' ? { ...t, rows: t.rows.slice(1) } : t)) } }),
			otherCase: J({ ...backup, case: { ...backup.case, caseId: 'another-case' } }),
			v5: J({ ess_dcs_timesheet_v1: [{ date: '2026-01-01', hours: 1 }], ess_dcs_courtbundle_v1: { x: 1 }, ess_dcs_bundle_extents_v1: null, ess_dcs_deadlines_v1: null }),
		};
		function dlText() { return readFileSync(backupPath, 'utf8'); }
		const out = {};
		await openView('backup_tab');
		const before = J(workDump());
		for (const [k, body] of Object.entries(files)) {
			const f = join(tmp, `${k}.json`);
			writeFileSync(f, body);
			await openView('backup_tab');
			out[k] = await restore({ file: f });
			out[k].unchanged = J(workDump()) === before;
		}
		// larger than the limit: refused in the page before anything is sent
		const big = join(tmp, 'big.json');
		writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
		await openView('backup_tab');
		await setFile('#restore-file', big);
		await sleep(100);
		const tooLarge = await text('#restore-too-large');
		await p.evaluate(`document.getElementById('restore-confirm').checked = true`);
		await p.click('#restore-submit');
		await sleep(500);
		const notSent = await p.evaluate(`!document.getElementById('restore-busy') && !document.getElementById('restore-done')`);
		rmSync(big);
		const after = J(workDump()) === before;
		return { evidence: { out, tooLarge, notSent },
			checks: { truncated: out.truncated.code === 'not-json' && out.truncated.unchanged, altered: out.altered.code === 'corrupt' && /checksum/.test(out.altered.error ?? '') && out.altered.unchanged,
				otherCase: out.otherCase.code === 'wrong-case' && /another case/.test(out.otherCase.error ?? '') && out.otherCase.unchanged,
				v5: /v5 browser backup/.test(out.v5.legacy ?? '') && /Nothing was changed/.test(out.v5.legacy ?? '') && /ess_dcs_courtbundle_v1\s*not imported: v5 never used this key/.test(out.v5.legacy ?? '') && /ess_dcs_timesheet_v1\s*not imported: no importer/.test(out.v5.legacy ?? '') && out.v5.unchanged,
				tooLarge: /larger than 64 MiB/.test(tooLarge ?? '') && notSent && after } };
	});

	await scenario('SY6-fresh-profile', 'backup_tab', 'the backup restored into a fresh profile (another data directory, the same case imported) by its typed path brings back the additions with the same refs', async () => {
		B = server('fresh', 43710);
		await B.start();
		const imp = await B.c.importPkg(sc.caseDir, sc.pkgDir);
		await B.c.activate(imp.importId);
		const brv = await B.c.activeVersion();
		await openView('rescan_tab', B, brv);
		const empty = await addedRefs();
		await openView('backup_tab', B, brv);
		const r = await restore({ path: backupPath });
		await openView('rescan_tab', B, brv);
		const back = await addedRefs();
		await B.stop();
		return { evidence: { brv, empty, r, back }, checks: { sameVersion: brv === rv, emptyBefore: empty.length === 0, restored: /^Restored /.test(r.done ?? ''), refs: J(back) === J(refs) } };
	});

	await scenario('SY11-large-upload', 'backup_tab', 'a backup file over 512 KB (the old default request limit) uploads and restores', async () => {
		// the note is outside the checksum, so padding it makes a valid backup larger than 512 KB
		const padded = join(tmp, 'padded.json');
		writeFileSync(padded, J({ ...backup, note: `${backup.note} ${' '.repeat(700 * 1024)}` }));
		await openView('backup_tab');
		const r = await restore({ file: padded });
		rmSync(padded);
		return { evidence: { r, bytes: 700 * 1024 }, checks: { restored: /^Restored /.test(r.done ?? '') && r.error === null } };
	});

	// 4. Bug classes on the restore form.
	await scenario('SY7-nojs', 'backup_tab', 'without JavaScript: a refused restore re-renders with its reason and the typed path; a valid one then restores', async () => {
		const bad = join(tmp, 'nojs-bad.json');
		writeFileSync(bad, '{"format":');
		await p.s('Emulation.setScriptExecutionDisabled', { value: true });
		try {
			const at = async () => { await p.navigate(`${A.origin}${vpath(rv)}/system/backup_tab`); await p.waitFor(`!!document.getElementById('restore-form')`, 20000); };
			const submit = async (path) => {
				await p.evaluate(`(() => { document.getElementById('restore-path').value = ${J(path)}; document.getElementById('restore-confirm').checked = true; window.__nojs = 1; return true; })()`);
				await p.click('#restore-submit');
				await p.waitFor(`window.__nojs !== 1 && !!document.getElementById('restore-form')`, 20000);
				return p.evaluate(`({ error: document.getElementById('restore-error')?.textContent.trim() ?? null, done: document.getElementById('restore-done')?.textContent.trim() ?? null, path: document.getElementById('restore-path').value, hydrated: !!document.querySelector('main#main[data-hydrated]') })`);
			};
			await at();
			const refused = await submit(bad);
			const done = await submit(backupPath);
			return { evidence: { refused, done }, checks: { noScripts: !refused.hydrated, refused: /not valid JSON/.test(refused.error ?? '') && refused.path === bad, restored: /^Restored /.test(done.done ?? '') && done.error === null } };
		} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
	});

	await scenario('SY8-inflight', 'backup_tab', 'a restore in flight on a busy store makes the form inert and says so; typing then changes nothing; the typed path and the outcome stay with the form', async () => {
		await openView('backup_tab');
		await p.type('#restore-path', backupPath);
		await p.evaluate(`document.getElementById('restore-confirm').checked = true`);
		const release = hold();
		let during;
		try {
			await p.click('#restore-submit');
			await p.waitFor(`!!document.getElementById('restore-busy')`, 10000);
			await p.type('#restore-path', 'typed during the restore');
			during = await p.evaluate(`({ disabled: document.querySelector('#restore-form fieldset').disabled, status: document.getElementById('restore-busy')?.textContent.trim() ?? null, path: document.getElementById('restore-path').value })`);
		} finally { release(); }
		await p.waitFor(`!document.getElementById('restore-busy')`, 30000);
		const after = await p.evaluate(`({ path: document.getElementById('restore-path').value, done: document.getElementById('restore-done')?.textContent.trim() ?? null, error: document.getElementById('restore-error')?.textContent.trim() ?? null })`);
		return { evidence: { during, after }, checks: { inert: during.disabled && /Checking and restoring/.test(during.status ?? ''), noTypingLost: during.path === backupPath && after.path === backupPath, outcome: /^Restored /.test(after.done ?? '') || /locked/.test(after.error ?? '') } };
	});

	// 5. Manual.
	await scenario('SY9-manual', 'manual', 'the badges, the OCR list and a real link-sample check; the Rescan & Update link and then Back return to the manual with the list and the focused heading', async () => {
		await openView('manual');
		const badges = await text('#manual-badges');
		await p.click('#manual-ocr');
		await p.waitFor(`!!document.getElementById('manual-ocr-list')`, 20000);
		const ocr = await tableRows('#manual-ocr-list');
		const ocrLabel = await text('#manual-ocr');
		await p.click('#manual-verify');
		await p.waitFor(`!!document.getElementById('manual-link-list')`, 20000);
		const links = await tableRows('#manual-link-list');
		const verified = await text('#manual-verify-result');
		await p.click('#manual-rescan');
		await p.waitFor(hydrated('rescan_tab'), 20000);
		await p.evaluate('history.back()');
		await p.waitFor(`${ready('manual')} && !!document.getElementById('manual-link-list')`, 20000);
		await sleep(150);
		const focus = await p.active();
		return { evidence: { badges, ocr, ocrLabel, links, verified, focus },
			checks: { badges: /^Documents 10 \(\+3 via rescan\) Emails \d+ People \S+ Scanned \(none\) \d+ Pending \d+$/.test(badges ?? ''), ocrList: ocrLabel === `List scanned documents needing OCR (${ocr.length})`,
				links: links.length === 1 && links[0][3] === 'found in the case folder' && verified === '1 of 1 found in the case folder.', focusAfterBack: focus?.heading === true } };
	});

	// 6. A 64-character case id with no break opportunity: no sideways scrolling at 320 and 390 px.
	await scenario('SY10-narrow', 'rescan_tab', 'the three system pages and the overview of a case whose 64-character id has no break opportunity do not scroll sideways at 320 and 390 px', async () => {
		const unbroken = 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz');
		const c = await buildCase(join(tmp, 'unbroken-id'), { caseId: unbroken });
		await putOriginal(c.caseDir, `DISCOVERY A/${'x'.repeat(80)}.pdf`, new TextEncoder().encode('%PDF-1.4 long'));
		const imp = await A.c.importPkg(c.caseDir, c.pkgDir);
		if (!imp.importId) throw new Error(`unbroken-id import failed: ${imp.status}`);
		const layouts = {};
		try {
			for (const width of [320, 390]) {
				await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
				await openView('rescan_tab', A, c.resultsVersion);
				if (width === 320) await scan();
				for (const [view, url] of [...SYSTEM_VIEWS.map((v) => [v, `/system/${v}`]), ['overview', '/overview']]) {
					await p.goto(`${A.origin}${vpath(c.resultsVersion)}${url}`, view === 'overview' ? ready(view) : hydrated(view));
					await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
					layouts[`${width}:${view}`] = await p.evaluate(`(() => { const de = document.documentElement; return { vw: de.clientWidth, scrollWidth: de.scrollWidth }; })()`);
				}
			}
		} finally { await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {}); }
		return { evidence: { idLength: unbroken.length, layouts }, checks: { idLength: unbroken.length === 64, noSideways: Object.values(layouts).every((l) => l.scrollWidth === l.vw), all: Object.keys(layouts).length === 8 } };
	});
	await scenario('SY12-restart-documents', 'rescan_tab', 'after a restart, before any system page loads, the chronology list includes the rescan additions', async () => {
		await A.stop();
		await A.start();
		const list = await fetch(`${A.origin}/api/v/${encodeURIComponent(rv)}/chronology`).then(async (r) => ({ status: r.status, text: await r.text() }));
		const found = refs.filter((ref) => list.text.includes(J(ref)));
		return { evidence: { status: list.status, refs, found }, checks: { ok: list.status === 200, additions: refs.length === 3 && found.length === 3 } };
	});
	ok = results.length > 0 && results.every((r) => r.pass);
} catch (e) {
	results.push({ id: 'HARNESS', view: '-', pass: false });
	writeFileSync(join(OUT, 'HARNESS.json'), J({ error: String(e?.stack ?? e).slice(0, 4000) }, null, 1));
	console.error(`FAIL    HARNESS ${String(e?.stack ?? e).slice(0, 2000)}`);
} finally {
	await b?.close().catch(() => {});
	await B?.stop().catch(() => {});
	await A?.stop().catch(() => {});
	if (tmp) rmSync(tmp, { recursive: true, force: true });
}
const missing = SYSTEM_VIEWS.filter((v) => !results.some((r) => r.view === v));
if (missing.length) ok = false;
writeFileSync(join(OUT, 'summary.json'), J({ ok, offline: true, clock: CLOCK, missing, scenarios: results }, null, 1));
console.log(`system: ${results.filter((r) => r.pass).length} PASS, ${results.filter((r) => !r.pass).length} FAIL${missing.length ? `, views without a scenario: ${missing.join(', ')}` : ''} -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
