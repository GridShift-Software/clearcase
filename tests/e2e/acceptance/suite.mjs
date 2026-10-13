#!/usr/bin/env bun
// The M2 acceptance workflow (GRS-21, CC-11): one offline browser run over the whole local path on synthetic cases, against
// the production build (./build) under Bun. Run it inside tests/e2e/pilot/offline.sh, as test:e2e runs a category suite:
//   unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" tests/e2e/pilot/offline.sh bun tests/e2e/acceptance/suite.mjs
// Scenarios, in order, each building on the last:
//   AC1  import a synthetic case through the Import form, read its report, acknowledge and activate;
//   AC2  every document's original resolves through the app: its document page names it and the originals site serves
//        the case folder's bytes (sha256); one opens in the real viewer from the document page;
//   AC3  every mutable state category edited through the UI: each POST form of every page is filled and submitted once
//        (destructive actions excepted), a note on a document, a rescan addition; then each of the 21 v5 user-work stores
//        of CC-10's coverage list (src/lib/user-work/backup/v5-keys.ts) and the notes hold a row;
//   AC4  a restart on the same data directory keeps every user-work row and the active version;
//   AC5  Export all state, then Import state into a clean profile (another data directory, the same case imported): every
//        user-work table, and so each of the 21 stores, equals the source profile's;
//   AC6  a failed import (a package whose file was altered after it was built) is rejected, offers no activation, and leaves
//        the active version and every user-work row unchanged;
//   AC7  a replacement package of the same case activates; every user-work row survives and the note still shows;
//   AC8  hostile imported text in every prose field of the results, and hostile originals: all 42 views and a document
//        page render inert (no script ran, no off-origin request, no javascript: link).
// Synthetic data only. Results: $CLEARCASE_E2E_OUT/acceptance/<scenario>.json and summary.json ({scenarios: [{id, view,
// pass}]}). Exit 0 only when every scenario passed.
process.env.CANARY_PORT ??= '44199';
const { createHash } = await import('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { INIT, nextPopup, openPage } = await import('../pilot/suite/browser.mjs');
const { appServer, vpath } = await import('../pilot/suite/context.mjs');
const { viewerState } = await import('../pilot/suite/main-flow.mjs');
const { mainCase } = await import('../pilot/suite/cases.mjs');
const { buildCase, hostileOriginals, hostileRows, pdf, putOriginal } = await import('../pilot/lib/fixtures.ts');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');
const { V5_STORES } = await import('../../../src/lib/user-work/backup/v5-keys.ts');
const { hasActions, pageTargets } = await import('../classes/targets.mjs');
const { revisionStamp } = await import('../../../scripts/verify/stamp.mjs');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'acceptance');
mkdirSync(OUT, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
const REVISION = revisionStamp(ROOT, BUILD);
const J = JSON.stringify;
const sha = (b) => createHash('sha256').update(b).digest('hex');

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

// ---- user work, read from outside the app ----------------------------------------------------------------------------

/** work.sqlite tables that are not user work: activation state, the catalogue, and accepted warnings (never restored). */
const NOT_USER_WORK = new Set(['active', 'activation_log', 'trusted_warning', 'userwork_catalog', 'userwork_catalog_scope', 'userwork_catalog_probe']);
/** Every user-work table and its rows, sorted, as stored. */
function userWork(server) {
	const out = {};
	for (const { name } of server.work("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
		if (NOT_USER_WORK.has(name)) continue;
		out[name] = server.work(`SELECT * FROM "${name.replace(/"/g, '""')}"`).map((r) => J(r)).sort();
	}
	return out;
}
const reg = (store) => ['register_row', `store = '${store}'`];
/** Where each v5 store of CC-10's coverage list lives in work.sqlite (tests/system/stores-21.test.ts writes the same). */
const STORE_ROWS = {
	ess_dcs_annotations_v1: reg('annotations'), ess_dcs_authorities_v1: reg('authorities'), ess_dcs_crossexam_v1: reg('crossexam'),
	ess_dcs_custom_bundles_v1: ['bundles_custom', '1'], ess_dcs_deadlines_v1: reg('deadlines'), ess_dcs_disbursements_v1: reg('disbursements'),
	ess_dcs_enf_status_v1: reg('enforcement-status'), ess_dcs_filings_v1: reg('filings-register'), ess_dcs_heads_v1: reg('heads'),
	ess_dcs_info_done_v1: reg('info-required'), ess_dcs_payments_v1: reg('payments'), ess_dcs_popia_v1: reg('popia'),
	ess_dcs_privilege_v1: reg('privilege'), ess_dcs_rescan_v1: ['rescan_file', '1'], ess_dcs_timesheet_v1: reg('timesheet'),
	ess_dcs_transcripts_v1: reg('transcripts'), ess_dcs_bundle_header_v2: reg('bundle-header'), ess_dcs_caselines_docs_v1: reg('caselines-links'),
	ess_dcs_schedule_co_v1: ['bundles_schedule_mark', "co IS NOT NULL AND co <> ''"], ess_dcs_schedule_mode_v1: reg('discovery-mode'),
	ess_dcs_schedule_sel_v1: ['bundles_schedule_mark', 'selected = 1'], note: ['note', '1'],
};
/** Each store's rows in `server`'s work.sqlite (as JSON lines, sorted); a missing table reads as no rows. */
function storeRows(server) {
	const out = {};
	for (const [key, [table, where]] of Object.entries(STORE_ROWS)) {
		try { out[key] = server.work(`SELECT * FROM "${table}" WHERE ${where}`).map((r) => J(r)).sort(); } catch { out[key] = []; }
	}
	return out;
}
const equalDumps = (a, b) => J(a) === J(b);

// ---- page helpers ------------------------------------------------------------------------------------------------------

let p, b, A, B, H, tmp, sc, rv;
const VIS = `(e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'`;
const settle = () => p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
const ready = (kind) => `document.querySelector('main#main')?.dataset.ready === ${J(kind)}`;
/** Wait until no request of the page is in flight for 400 ms (a save and the reload it triggers). */
async function quiet(timeout = 15000) {
	const t0 = Date.now();
	let last = Date.now();
	const inflight = new Set();
	const off = b.on((m) => {
		if (m.sessionId !== p.sessionId) return;
		if (m.method === 'Network.requestWillBeSent') { inflight.add(m.params.requestId); last = Date.now(); }
		if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight.delete(m.params.requestId); last = Date.now(); }
	});
	try { while (Date.now() - t0 < timeout && (inflight.size || Date.now() - last < 400)) await sleep(50); } finally { off(); }
	await settle();
}
/** The page's POST forms, one per action attribute, marked data-acc="<i>" with their submit button data-acc-s="<i>". */
const FORMS = `(() => {
	const seen = new Map();
	for (const f of document.querySelectorAll('form')) { if ((f.getAttribute('method') || '').toUpperCase() !== 'POST') continue; const a = f.getAttribute('action') || ''; if (!seen.has(a)) seen.set(a, f); }
	const isSubmit = (e) => (e.tagName === 'BUTTON' && e.type === 'submit') || (e.tagName === 'INPUT' && e.type === 'submit');
	return [...seen].map(([action, f], i) => {
		f.dataset.acc = String(i);
		const sub = [...f.elements].find((e) => isSubmit(e) && !e.hasAttribute('formaction') && (${VIS})(e)) ?? [...f.elements].find((e) => isSubmit(e) && !e.hasAttribute('formaction'));
		if (sub) sub.dataset.accS = String(i);
		return { i, action, id: f.id || null, submit: sub ? '[data-acc-s="' + i + '"]' : null, disabled: !!sub?.disabled };
	});
})()`;
/** Fill form `i` as a user would: text gets `Acceptance <name> <tag>`, number-like names a number, dates a date, a select its first option, a checkbox is ticked. */
const fillForm = (i, tag) => p.evaluate(`(() => {
	const f = document.querySelector('[data-acc="${i}"]');
	const set = (e, v) => { const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
	const filled = {};
	for (const e of f.elements) {
		if (!e.name || e.disabled || e.readOnly || e.type === 'hidden' || e.type === 'file' || e.type === 'submit' || e.tagName === 'BUTTON') continue;
		if (e.type === 'checkbox' || e.type === 'radio') { if (!e.checked) { e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); } filled[e.name] = 'on'; continue; }
		const num = /amount|hours|rate|sum|value|qty|number|pages/i.test(e.name) || e.type === 'number';
		const v = e.tagName === 'SELECT' ? ([...e.options].find((o) => o.value)?.value ?? '') : e.type === 'date' ? '2026-10-01' : num ? '10' : 'Acceptance ' + e.name + ' ${tag}';
		set(e, v); filled[e.name] = v;
	}
	return filled;
})()`);
/** Actions that remove, replace or clear user work, or change the active case: never driven by the edit sweep. */
const DESTRUCTIVE = /\?\/(delete|delnote|unlink|clear|restore|rollback|import|activate|adopt|cancel)\b/;

async function importThroughUi(server, caseDir, pkgDir) {
	await p.goto(`${server.origin}/import`, `!!document.querySelector('#import-form')`);
	await p.type('#caseFolder', caseDir);
	await p.type('#packageSource', pkgDir);
	await p.click('#validate');
	await p.waitFor(`/^\\/import\\/\\d+$/.test(location.pathname) && !!document.querySelector('main[data-verdict]')`, 60000);
	return p.evaluate(`({ path: location.pathname, verdict: document.querySelector('main').dataset.verdict, rv: document.querySelector('#results-version')?.textContent.trim() ?? null, ack: !!document.querySelector('#ack'), activate: !!document.querySelector('#activate') })`);
}
async function activateThroughUi() {
	if (await p.evaluate(`!!document.querySelector('#ack') && !document.querySelector('#ack').checked`)) await p.click('#ack');
	await p.click('#activate');
	await p.waitFor(`!location.pathname.startsWith('/import/') || !!document.querySelector('#activate-error')`, 30000);
	await quiet();
	return p.evaluate(`({ path: location.pathname, error: document.querySelector('#activate-error')?.textContent.trim() ?? null })`);
}

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
writeFileSync(join(OUT, 'offline.json'), J(offline, null, 1));
if (!offline.pass) { console.error('acceptance suite: not offline'); writeFileSync(join(OUT, 'summary.json'), J({ ok: false, offline: false, revision: REVISION, scenarios: [] })); process.exit(1); }
tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-acceptance-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const server = (name, port) => appServer({ name, root: ROOT, buildDir: BUILD, port, origPort: port + 1, dir: tmp, env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
let ok = false;
try {
	A = server('a', 44100);
	await A.start();
	// the pilot's main case (real multi-page PDF originals); its replacement is the same case's v2 (cases.mjs mainCase dated)
	sc = await mainCase(join(tmp, 'case'));
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: INIT });

	await scenario('AC1-import', 'overview', 'a synthetic case imported through the Import form: report verdict, acknowledgement, activation; the overview opens on the new version', async () => {
		const before = await A.c.activeVersion();
		const rep = await importThroughUi(A, sc.caseDir, sc.pkgDir);
		const act = await activateThroughUi();
		rv = await A.c.activeVersion();
		await p.goto(`${A.v(rv)}/overview`, ready('overview'));
		const title = await p.evaluate('document.title');
		return { evidence: { before, rep, act, rv, title }, checks: { nothingBefore: before === null, reported: ['accept', 'report'].includes(rep.verdict), activatable: rep.activate, activated: rv === sc.resultsVersion && act.error === null, overview: title.startsWith('Overview') } };
	});

	await scenario('AC2-originals', 'chronology', "every document's original resolves through the app (document page link, the originals site serves the case folder's bytes), and one opens in the real viewer", async () => {
		const docs = A.results('SELECT ref FROM document WHERE version_id = ? ORDER BY ord', rv).map((r) => r.ref);
		const bytesByRef = new Map();
		// the expected bytes are the case folder's originals, read from disk by each chronology row's url (never the results package's files)
		for (const r of sc.chronology) { const f = join(sc.caseDir, ...decodeURIComponent(String(r.url).replace(/^\.\//, '')).split('/')); try { bytesByRef.set(r.ref, readFileSync(f)); } catch { /* no original on disk: the ref stays uncompared and fails below */ } }
		const rows = [];
		for (const ref of docs) {
			const html = await (await fetch(`${A.v(rv)}/doc/${encodeURIComponent(ref)}`)).text();
			// the bytes come from the download link (/o/...); a document with only a viewer link is checked through its wrapper
			const find = (id) => { const m = new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>`).exec(html); return m ? /href="([^"]+)"/.exec(m[0])?.[1]?.replace(/&amp;/g, '&') ?? null : null; };
			const link = find('download-original') ?? find('open-original');
			let status = null, match = null;
			if (link) {
				const u = new URL(link, A.orig);
				const r = await A.o(u.pathname + u.search);
				status = r.status;
				const want = bytesByRef.get(ref);
				match = u.pathname.startsWith('/o/') && want ? sha(r.body) === sha(want) : null;
			}
			rows.push({ ref, link: !!link, kind: link ? new URL(link, A.orig).pathname.split('/')[1] : null, status, match });
		}
		await p.goto(`${A.v(rv)}/doc/OD-001`, ready('doc:OD-001'));
		const pop = nextPopup(b, 10000);
		await p.click('#open-original');
		const w = await pop;
		let viewer;
		try { await sleep(400); viewer = await viewerState(b, w); } finally { await w.close(); }
		const unresolved = rows.filter((r) => !r.link || r.status !== 200);
		const opened = rows.filter((r) => r.link && r.status === 200);
		const unverified = opened.filter((r) => r.match !== true).map((r) => r.ref);
		return { evidence: { documents: rows.length, compared: opened.length - unverified.length, unresolved, unverified, mismatched: rows.filter((r) => r.match === false).map((r) => r.ref), viewer: { ready: viewer.wrapper.ready, sandbox: viewer.wrapper.sandbox, canvases: viewer.frame.canvases, origin: viewer.frame.origin } },
			checks: { documents: rows.length > 0, allResolve: unresolved.length === 0, bytes: opened.length > 0 && unverified.length === 0, viewer: viewer.frame.canvases > 0 && viewer.frame.origin !== A.origin } };
	});

	const edits = [];
	await scenario('AC3-edit-all', 'backup_tab', 'every mutable state category edited through the UI; each of the 21 v5 stores of the coverage list and the notes hold a row', async () => {
		// a note on a document
		await p.goto(`${A.v(rv)}/doc/OD-001`, ready('doc:OD-001'));
		await p.type('#note-body', 'Acceptance note on OD-001');
		await p.click('#note-add');
		await quiet();
		// a rescan addition: a new original in the case folder, found by Rescan now
		await putOriginal(sc.caseDir, 'DISCOVERY A/OD-009 Acceptance addition.pdf', new TextEncoder().encode('%PDF-1.4 acceptance addition'));
		// every form of every page, once; pages whose saves need a row first (a row to mark) are visited twice
		const pages = pageTargets(ROOT, { vpath, rv, ref: 'OD-001', importId: 1, views: VIEWS }).filter((t) => t.url && hasActions(ROOT, t.route) && t.route.startsWith('/v/'));
		for (const round of [1, 2]) {
			for (const t of pages) {
				// a page that does not load is an edit that did not happen, not a page without forms
				const loadError = await p.goto(A.origin + t.url, 'true', 20000).then(() => null, (e) => String(e?.message ?? e).slice(0, 200));
				if (loadError) edits.push({ round, route: t.route, view: t.view, action: '(page load)', ok: false, error: loadError, alerts: [] });
				await settle();
				const forms = await p.evaluate(FORMS);
				for (const f of forms) {
					if (DESTRUCTIVE.test(f.action) || !f.submit) continue;
					if (round === 2 && edits.some((e) => e.route === t.route && e.action === f.action && e.ok)) continue;
					await p.evaluate(FORMS); // re-mark after an earlier save re-rendered the page
					const filled = await fillForm(f.i, `${t.view} ${round}`);
					const disabled = await p.evaluate(`!!document.querySelector(${J(f.submit)})?.disabled`);
					let ok = false, error = null;
					if (!disabled) {
						try { await p.click(f.submit); await quiet(); ok = true; } catch (e) { error = String(e).slice(0, 200); }
					}
					const alerts = await p.evaluate(`[...document.querySelectorAll('[role=alert], .error')].filter(${VIS}).map((e) => e.textContent.trim().slice(0, 120)).filter(Boolean)`);
					edits.push({ round, route: t.route, view: t.view, action: f.action, fields: Object.keys(filled), disabled, ok: ok && alerts.length === 0, error, alerts });
				}
			}
		}
		// the pages that save without a <form> submit (tests/e2e/classes/declared.mjs NO_FORM, NOT_APPLICABLE): driven as a user does
		const V = (cat, view) => `${A.v(rv)}/${cat}/${view}`;
		const drive = async (name, url, view, steps) => {
			let error = null;
			try { await p.goto(url, ready(view), 20000); await settle(); await steps(); await quiet(); } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
			edits.push({ round: 'driver', route: name, view, action: name, ok: error === null, error, alerts: [] });
		};
		const pdfDir = join(tmp, 'build-pdfs');
		mkdirSync(pdfDir, { recursive: true });
		writeFileSync(join(pdfDir, 'Acceptance_Statement.pdf'), pdf('acceptance statement'));
		await drive('info-required toggle', V('analysis', 'info_required_tab'), 'info_required_tab', async () => { await p.click('main input[type=checkbox]'); });
		await drive('enforcement status', V('litigation', 'enforcement_tab'), 'enforcement_tab', async () => {
			await p.evaluate(`(() => { const s = document.querySelector('select[name^="status:"]'); const o = [...s.options].find((x) => x.value && x.value !== s.value); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
		});
		await drive('discovery selection, Copy/Original mark, mode', V('bundles', 'discovery_tab'), 'discovery_tab', async () => {
			await p.click('#ds-list .ds-chip input[type=checkbox]');
			await quiet();
			await p.click('#ds-list .ds-chip button[aria-label=Copy]');
			await quiet();
			await p.click('#main .ds-switch button[data-mode="supplementary"]');
		});
		await drive('CaseLines link', V('bundles', 'caselines_tab'), 'caselines_tab', async () => { await p.type('#cl-path', 'DISCOVERY A/OD-001 Acceptance link.pdf'); await p.click('#cl-link'); });
		await drive('court bundle header', V('bundles', 'court_bundle_tab'), 'court_bundle_tab', async () => { await p.type('#cbh_court', 'Acceptance High Court'); await p.click('#cb-save'); });
		await drive('court bundle builder save', V('bundles', 'court_bundle_tab'), 'court_bundle_tab', async () => {
			await p.click('#cb-build');
			await p.waitFor(`document.getElementById('cbbfile')`, 30000);
			const { root } = await p.s('DOM.getDocument');
			const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cbbfile' });
			await p.s('DOM.setFileInputFiles', { nodeId, files: [join(pdfDir, 'Acceptance_Statement.pdf')] });
			await p.waitFor(`document.querySelectorAll('#cbbfiles tbody tr').length === 1 && !document.getElementById('cbbmsg').textContent`, 30000);
			await p.type('#cbbname', 'Acceptance Build');
			await p.click('#cbbrun');
			await p.waitFor(`document.getElementById('cbbdownload')`, 60000);
			await p.click('#cbbsave');
			await p.waitFor(`!!new URLSearchParams(location.search).get('b')`, 30000);
		});
		const rows = storeRows(A);
		const counts = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length]));
		const missing = [...V5_STORES.map((s) => s.key), 'note'].filter((k) => !counts[k]);
		// every form and driven page saved at least once (a form skipped in round 1 for want of a row may succeed in round 2); a form whose submit stayed disabled is not an edit
		const byAction = new Map();
		for (const e of edits) if (!e.disabled) byAction.set(`${e.route} ${e.action}`, (byAction.get(`${e.route} ${e.action}`) ?? false) || e.ok);
		const notSaved = [...byAction].filter(([, saved]) => !saved).map(([k]) => k);
		return { evidence: { counts, missing, notSaved, edits }, checks: { editsSaved: byAction.size > 0 && notSaved.length === 0, coverageList: J(V5_STORES.map((s) => s.key).sort()) === J(Object.keys(STORE_ROWS).filter((k) => k !== 'note').sort()), everyStore: missing.length === 0 } };
	});

	let beforeRestart;
	await scenario('AC4-restart', 'overview', 'a restart on the same data directory keeps every user-work row and the active version; the registers show their rows', async () => {
		beforeRestart = userWork(A);
		await A.stop();
		await A.start();
		const after = userWork(A);
		const active = await A.c.activeVersion();
		await p.goto(`${A.v(rv)}/registers/deadlines_tab`, ready('deadlines_tab'));
		const shown = await p.evaluate(`document.querySelector('main#main').textContent.includes('Acceptance')`);
		return { evidence: { tables: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.length])), active, shown }, checks: { rows: equalDumps(beforeRestart, after), active: active === rv, shown } };
	});

	await scenario('AC5-backup-restore-clean', 'backup_tab', 'Export all state, then Import state into a clean profile: every user-work table and each of the 21 stores equal the source', async () => {
		await p.goto(`${A.v(rv)}/system/backup_tab`, ready('backup_tab'));
		const exp = await p.evaluate(`fetch(document.querySelector('#backup-export').href).then(async (r) => ({ status: r.status, disposition: r.headers.get('content-disposition'), text: await r.text() }))`);
		const file = join(tmp, 'acceptance-backup.json');
		writeFileSync(file, exp.text);
		B = server('b', 44110);
		await B.start();
		const empty = storeRows(B);
		const imp = await B.c.importPkg(sc.caseDir, sc.pkgDir);
		await B.c.activate(imp.importId);
		const brv = await B.c.activeVersion();
		await p.goto(`${B.v(brv)}/system/backup_tab`, ready('backup_tab'));
		await p.type('#restore-path', file);
		await p.evaluate(`document.getElementById('restore-confirm').checked = true`);
		await p.click('#restore-submit');
		await p.waitFor(`!document.getElementById('restore-busy') && !!(document.getElementById('restore-done') || document.getElementById('restore-error'))`, 30000);
		const outcome = await p.evaluate(`({ done: document.getElementById('restore-done')?.textContent.trim() ?? null, error: document.getElementById('restore-error')?.textContent.trim() ?? null })`);
		const src = storeRows(A), dst = storeRows(B);
		const perStore = Object.fromEntries(Object.keys(STORE_ROWS).map((k) => [k, src[k].length > 0 && J(src[k]) === J(dst[k])]));
		const a = userWork(A), bw = userWork(B);
		const tables = Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(bw)])].map((t) => [t, J(a[t] ?? []) === J(bw[t] ?? [])]));
		await B.stop();
		return { evidence: { export: { status: exp.status, disposition: exp.disposition, bytes: exp.text.length }, sameVersion: brv === rv, emptyBefore: Object.values(empty).every((v) => v.length === 0), outcome, perStore, tables },
			checks: { exported: exp.status === 200, cleanProfile: Object.values(empty).every((v) => v.length === 0), restored: !!outcome.done && !outcome.error, everyStore: Object.values(perStore).every(Boolean), everyTable: Object.values(tables).every(Boolean) } };
	});

	await scenario('AC6-failed-import', 'overview', 'a package altered after it was built is rejected with no activation offered; the active version and every user-work row are unchanged', async () => {
		const bad = await mainCase(join(tmp, 'bad'), { caseDir: sc.caseDir, dated: true });
		const { readdirSync } = await import('node:fs');
		const victim = readdirSync(bad.pkgDir, { recursive: true }).map(String).find((f) => /\.(jsonl?|json\.gz)$/.test(f) && !/manifest/i.test(f));
		const vf = join(bad.pkgDir, victim);
		writeFileSync(vf, Buffer.concat([readFileSync(vf), Buffer.from('\n')]));
		const before = userWork(A);
		const rep = await importThroughUi(A, sc.caseDir, bad.pkgDir);
		const active = await A.c.activeVersion();
		await p.goto(`${A.v(rv)}/overview`, ready('overview'));
		return { evidence: { altered: victim, rep, active }, checks: { rejected: rep.verdict === 'reject', noActivation: !rep.activate, stillActive: active === rv, unchanged: equalDumps(before, userWork(A)) } };
	});

	await scenario('AC7-replacement', 'overview', 'a replacement package of the same case (its v2: dated rows with date type and source) activates; every user-work row survives and the note still shows', async () => {
		const next = await mainCase(join(tmp, 'next'), { caseDir: sc.caseDir, dated: true });
		const before = storeRows(A);
		const rep = await importThroughUi(A, sc.caseDir, next.pkgDir);
		const act = await activateThroughUi();
		const active = await A.c.activeVersion();
		const after = storeRows(A);
		// the rows themselves survive, not just as many rows: every row before is still in the store after, and no store was empty to begin with
		const kept = Object.fromEntries(Object.keys(before).map((k) => { const now = new Set(after[k]); return [k, before[k].length > 0 && before[k].every((r) => now.has(r))]; }));
		await p.goto(`${A.v(active)}/doc/OD-001`, ready('doc:OD-001'));
		const note = await p.evaluate(`document.querySelector('#notes')?.textContent.includes('Acceptance note on OD-001') ?? false`);
		return { evidence: { rep: { verdict: rep.verdict, rv: rep.rv }, act, active, kept, note }, checks: { replaced: active === next.resultsVersion && active !== rv, everyStoreKept: Object.values(kept).every(Boolean), note } };
	});

	await scenario('AC8-hostile-all-views', 'overview', 'hostile text in every prose field and hostile originals: all 42 views and a hostile document page render inert', async () => {
		// a javascript: link in a narrative field is refused at validation (LINK_UNSAFE_SCHEME): shown with the first package;
		// the second carries every other payload, imports, and is rendered
		const SCRIPTS = ` <script>window.__acc_xss=1</script><img src=x onerror="window.__acc_xss=2"><svg onload="window.__acc_xss=3"></svg><iframe srcdoc="<script>parent.__acc_xss=6</script>"></iframe> [[OD-001" onmouseover="window.__acc_xss=7]]`;
		const LINKS = ` <a href="javascript:window.__acc_xss=4">j</a> [x](javascript:window.__acc_xss=5)`;
		let touched = 0;
		const poison = (v, key, payload) => {
			if (Array.isArray(v)) return v.map((x) => poison(x, key, payload));
			if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x, k, payload)]));
			if (typeof v === 'string' && v.length > 12 && / /.test(v) && !/[/\\]|\.pdf$|^\d{4}-\d\d/.test(v) && !/^(ref|file|path|url|link|date|bundle|doc_type|id)$/i.test(key ?? '')) { touched++; return v + payload; }
			return v;
		};
		H = server('h', 44120);
		await H.start();
		const linked = await buildCase(join(tmp, 'hostile-links'), { caseId: 'e2e-acceptance-hostile', originals: hostileOriginals(), rows: hostileRows(), edit: (r) => { r.DATA = poison(r.DATA, null, SCRIPTS + LINKS); } });
		const refusedImp = await H.c.importPkg(linked.caseDir, linked.pkgDir);
		const refused = refusedImp.importId ? await H.c.report(refusedImp.importId) : null;
		const refusedActive = await H.c.activeVersion();
		touched = 0;
		const hc = await buildCase(join(tmp, 'hostile'), { caseId: 'e2e-acceptance-hostile', originals: hostileOriginals(), rows: hostileRows(), edit: (r) => { r.DATA = poison(r.DATA, null, SCRIPTS); } });
		const imp = await H.c.importPkg(hc.caseDir, hc.pkgDir);
		await H.c.activate(imp.importId);
		const hrv = await H.c.activeVersion();
		const linkRefusal = { verdict: refused?.verdict ?? null, unsafeScheme: refused?.codes?.LINK_UNSAFE_SCHEME ?? null, activeAfter: refusedActive };
		if (hrv !== hc.resultsVersion) return { evidence: { poisonedFields: touched, linkRefusal, import: { status: imp.status, location: imp.location }, report: imp.importId ? await H.c.report(imp.importId).catch((e) => String(e)) : null }, checks: { activated: false } };
		const t0 = Date.now();
		const views = [];
		for (const v of VIEWS) {
			await p.goto(`${H.v(hrv)}${v.route}`, ready(v.id), 10000).catch(() => {});
			await settle();
			views.push({ view: v.id, ...(await p.evaluate(`({ ready: document.querySelector('main#main')?.dataset.ready ?? null, xss: window.__acc_xss ?? null, title: document.title, jsLinks: [...document.querySelectorAll('a[href]')].filter((a) => /^\\s*javascript:/i.test(a.getAttribute('href'))).length, injected: document.querySelectorAll('main img[src="x"], main svg[onload], main script:not([src])').length, payloadText: document.querySelector('main#main')?.textContent.includes('__acc_xss') ?? false })`)) });
		}
		await p.goto(`${H.v(hrv)}/doc/HX-001`, ready('doc:HX-001'), 10000).catch(() => {});
		const doc = await p.evaluate(`({ ready: document.querySelector('main#main')?.dataset.ready ?? null, xss: window.__acc_xss ?? null, title: document.title, injected: document.querySelectorAll('main img[src="x"], main script:not([src])').length })`);
		const offOrigin = b.events.requests.filter((r) => r.at >= t0).filter((r) => { try { const u = new URL(r.url); return /^(https?|wss?):$/.test(u.protocol) && !['127.0.0.1', 'localhost', 'clearcase-originals.localhost'].includes(u.hostname); } catch { return false; } }).map((r) => r.url.slice(0, 120));
		await H.stop();
		const bad = views.filter((x) => x.xss !== null || x.jsLinks || x.injected || /PWNED/.test(x.title) || x.ready !== x.view);
		return { evidence: { poisonedFields: touched, linkRefusal, views: views.length, bad, shownAsText: views.filter((x) => x.payloadText).map((x) => x.view), doc, offOrigin },
			checks: { linkRefused: linkRefusal.unsafeScheme === 'error' && linkRefusal.activeAfter === null, poisoned: touched > 0, allViews: views.length === 42, inert: bad.length === 0, docInert: doc.ready === 'doc:HX-001' && doc.xss === null && doc.injected === 0 && !/PWNED/.test(doc.title), noOffOrigin: offOrigin.length === 0 } };
	});
	ok = results.length === 8 && results.every((r) => r.pass);
} catch (e) {
	console.error(`acceptance suite: ${String(e?.stack ?? e).slice(0, 2000)}`);
} finally {
	await p?.close().catch(() => {});
	await b?.close().catch(() => {});
	for (const s of [H, B, A]) await s?.stop().catch(() => {});
	writeFileSync(join(OUT, 'summary.json'), J({ ok, offline: true, revision: REVISION, scenarios: results }, null, 1));
	rmSync(tmp, { recursive: true, force: true });
}
console.log(`acceptance suite: ${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
process.exit(ok ? 0 : 1);
