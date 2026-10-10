#!/usr/bin/env bun
// Offline browser suite of the litigation views (GRS-18, CC-08), run by `bun run --bun test:e2e` in its own network
// namespace after the pilot suites. It starts its own production server (tests/e2e/pilot/lib/server.mjs through the
// pilot's restartable appServer) on a fresh data directory, imports synthetic cases built by GRS-10's converter, and
// drives every litigation view in Chromium with real clicks and typing. Failures are caused from outside the app: a
// busy work.sqlite (BEGIN IMMEDIATE held by this process with bun:sqlite) and a stopped server. Each scenario's result
// goes to $CLEARCASE_E2E_OUT/litigation/<id>.json and the list to summary.json; the exit code is 1 when any scenario
// fails, the run is not offline, or a page requested anything off loopback.
process.env.CANARY_PORT ??= '43399';
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { outDir } = await import('../pilot/lib/record.mjs');
const { CHROME, launch } = await import('../pilot/lib/cdp.mjs');
const { bunIdentity } = await import('../pilot/lib/server.mjs');
const { appServer } = await import('../pilot/suite/context.mjs');
const { INIT, openPage, sleep } = await import('../pilot/suite/browser.mjs');
const { CASE_ID, emptyCase, mainCase, reorderedCase, viewContentText } = await import('./lib/cases.mjs');

const J = JSON.stringify;
const ROOT = resolve(process.env.E2E_ROOT ?? join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const OUT = join(outDir(), 'litigation');
mkdirSync(OUT, { recursive: true });
const { VIEWS } = await import(join(ROOT, 'src', 'lib', 'components', 'view-registry.ts'));
const LIT = VIEWS.filter((v) => v.category === 'litigation');
const label = (id) => VIEWS.find((v) => v.id === id).label;
const PORT = 43100, ORIG = 43101;

// ---- scenario recording ------------------------------------------------------------------------------------------
const scenarios = [];
// development only: CC08_E2E_ONLY=<id>[,<id>…] runs just those scenarios (a revert-the-fix check); test:e2e never sets it,
// and a filtered run names the filter in its summary
const ONLY = process.env.CC08_E2E_ONLY ? new Set(process.env.CC08_E2E_ONLY.split(',')) : null;
async function scenario(id, view, title, fn) {
	if (ONLY && !ONLY.has(id)) return;
	const t0 = Date.now();
	let pass = false, evidence;
	try { const r = await fn(); pass = r?.pass === true; evidence = r?.evidence ?? r; } catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	const ms = Date.now() - t0;
	scenarios.push({ id, view, pass, title, ms });
	writeFileSync(join(OUT, `${id}.json`), J({ id, view, title, pass, ms, evidence }, null, 1));
	console.log(`${pass ? 'PASS   ' : 'FAIL   '} ${id} [${view}] ${title} (${ms} ms)`);
}
/** Pass when every check is true; `evidence` (when given) is recorded, never checked. */
const all = ({ evidence, ...checks }) => ({ pass: Object.values(checks).every((v) => v === true), evidence: { checks, ...(evidence === undefined ? {} : { data: evidence }) } });

// ---- page helpers ------------------------------------------------------------------------------------------------
/** In-page download capture (the app's download() clicks a Blob anchor): content, never files on disk. */
const HOOK = `(() => { window.__dl = []; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__dl.push({ name: this.download, blob: o }); return; } return click.call(this); };
})()`;
const takeDownloads = (p) => p.evaluate(`Promise.all(window.__dl.splice(0).map(async (d) => ({ name: d.name, type: d.blob.type, text: await d.blob.text() })))`);
const ready = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)}`;
const val = (p, sel) => p.evaluate(`document.querySelector(${J(sel)})?.value ?? null`);
const text = (p, sel) => p.evaluate(`(document.querySelector(${J(sel)})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
const count = (p, sel) => p.evaluate(`document.querySelectorAll(${J(sel)}).length`);
/** Fill a form's fields by selector (typing like a user). */
async function fill(p, fields) { for (const [sel, v] of Object.entries(fields)) await p.type(sel, v); }
/** Wait until `expr` holds or `ms` passes; returns the last value. */
async function until(p, expr, ms = 20000) { try { return await p.waitFor(expr, ms); } catch { return p.evaluate(expr).catch(() => null); } }

// ---- run ---------------------------------------------------------------------------------------------------------
const offline = await proveOffline();
const stamp = existsSync(join(BUILD, 'clearcase-build.json')) ? JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')) : null;
const tmp = mkdtempSync(join(process.env.CLEARCASE_TEST_TMP ?? tmpdir(), 'cc08-e2e-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const A = appServer({ name: 'lit', root: ROOT, buildDir: BUILD, port: PORT, origPort: ORIG, dir: tmp });
let b, p, offLoopback = [];
const work = (sql, ...args) => A.work(sql, ...args);
const STORES = ['crossexam', 'authorities', 'heads', 'enforcement-status'];
const savedRows = () => work(`SELECT case_id, store, row_id, fields FROM register_row WHERE store IN (${STORES.map(() => '?').join(',')}) ORDER BY case_id, store, row_id`, ...STORES);
const overlays = () => work(`SELECT case_id, dataset_key, seed_id, base_seed_sha256, fields FROM seed_overlay ORDER BY case_id, dataset_key, seed_id`);
const rowsWhere = (store, key, value) => savedRows().filter((r) => r.store === store && JSON.parse(r.fields)[key] === value);

try {
	if (!offline.pass) throw new Error(`not offline: ${J(offline)}`);
	await A.start();
	const main = await mainCase(join(tmp, 'main'));
	const empty = await emptyCase(join(tmp, 'empty'));
	const imp = await A.c.importPkg(main.caseDir, main.pkgDir);
	const act = await A.c.activate(imp.importId, { ack: true });
	if ((await A.c.activeVersion()) !== main.resultsVersion) throw new Error(`activation failed: ${J({ imp, act })}`);
	const impEmpty = await A.c.importPkg(empty.caseDir, empty.pkgDir);
	if (!impEmpty.importId) throw new Error(`empty case import failed: ${J(impEmpty)}`);
	const V = A.v(main.resultsVersion), VE = A.v(empty.resultsVersion);
	const route = (id) => VIEWS.find((v) => v.id === id).route;
	const titleName = viewContentText(main, '_shell', 'documentTitle') ?? CASE_ID;

	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: `${INIT};${HOOK}` });

	// ---- every view: title, heading, focus after navigation, current entry (BA-14, BA-16, BA-18) --------------------
	for (const v of LIT) {
		await scenario(`NAV-${v.id}`, v.id, `${v.label}: reached from the navigation, heading focused, title '${v.label} · <case> · ClearCase', current entry marked`, async () => {
			await p.goto(`${V}/overview`, ready('overview'));
			await p.click(`#nav-${v.id}`);
			await until(p, `${ready(v.id)} && location.pathname.endsWith(${J(v.route)})`);
			await sleep(80);
			const got = await p.evaluate(`({ path: location.pathname, title: document.title, h1: document.querySelector('h1')?.textContent.trim(), focus: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null, unavailable: !!document.querySelector('[data-unavailable]'), note: !!document.querySelector('[data-source-note]') || !!document.querySelector('#conf-scope') })`);
			return all({ path: got.path.endsWith(v.route), title: got.title === `${v.label} · ${titleName} · ClearCase`, heading: got.h1 === v.label, focus: got.focus, current: got.current === `nav-${v.id}`, available: !got.unavailable, scopeNote: got.note });
		});
	}

	// ---- 1. roadmap content -----------------------------------------------------------------------------------------
	let keys = [];
	await scenario('S1-roadmap', 'enforcement_tab', 'roadmap content: phases in first-appearance order, steps in data order, view-content subtitle and narrative, authored citations, footer and scope note; an imported status outside ENF_OPTS stays selected; a duplicate step is disclosed without a status', async () => {
		await p.goto(`${V}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const got = await p.evaluate(`({
			phases: [...document.querySelectorAll('#main .chead')].map((e) => e.textContent.trim()),
			steps: [...document.querySelectorAll('#main table tbody tr')].map((r) => r.cells[0].textContent.trim()),
			values: [...document.querySelectorAll('#main table tbody tr')].map((r) => r.querySelector('select')?.value ?? null),
			options: [...document.querySelectorAll('#main table tbody tr')][2]?.querySelector('select') ? [...[...document.querySelectorAll('#main table tbody tr')][2].querySelector('select').options].map((o) => o.textContent) : null,
			keys: [...document.querySelectorAll('#main tr[data-step]')].map((r) => r.dataset.step),
			duplicates: document.querySelectorAll('[data-duplicate]').length,
			subtitle: document.querySelector('.subtitle')?.textContent.trim(),
			why: document.querySelector('.narr .narrative')?.textContent.trim(),
			cite: document.querySelector('#main table a.cite')?.getAttribute('href'),
			broken: document.querySelector('#main table .cite-broken')?.textContent.trim(),
			footer: [...document.querySelectorAll('#main p.tag')].map((e) => e.textContent.trim()),
			note: document.querySelector('[data-source-note]')?.textContent.trim() })`);
		keys = got.keys;
		return all({
			phases: J(got.phases) === J(['1 · Start', '2 · Next', '3 · Twice']),
			steps: J(got.steps) === J(['Synthetic step A', 'Synthetic step C', 'Synthetic step B', 'Synthetic twin', 'Synthetic twin']),
			values: J(got.values) === J(['To do', 'Contingent', 'Awaiting counsel', null, null]),
			outsideOption: J(got.options) === J(['To do', 'In progress', 'Done', 'Contingent', 'Monitor', 'Awaiting counsel']),
			keys: got.keys.length === 5 && got.keys.slice(0, 3).every((k) => /^[0-9a-f]{64}$/.test(k)) && got.keys[3] === 'duplicate' && new Set(got.keys.slice(0, 3)).size === 3,
			duplicates: got.duplicates === 2,
			subtitle: got.subtitle === viewContentText(main, 'enforcement_tab', 'subtitle'),
			why: got.why === viewContentText(main, 'enforcement_tab', 'whyNarrative'),
			citation: got.cite === `/v/${encodeURIComponent(main.resultsVersion)}/doc/OD-001`, brokenCitation: got.broken === '[[ZZ-404]]',
			footer: got.footer.includes('Legal framework is a working aide — verify each authority (see Authorities tab) before relying on it.'),
			note: /has not verified it/.test(got.note ?? ''), evidence: got,
		});
	});

	// ---- 2. change and reload a status; it follows its step in a reordered version ------------------------------------
	await scenario('S2-status', 'enforcement_tab', 'change a roadmap status: saved on change, kept after reload and restart of the page, stored as {stepKey, status} with the imported status unchanged; in a later version with the steps reordered it stays on the same step (S-enforcement_tab-1, S-index-keys)', async () => {
		await p.goto(`${V}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const keyC = keys[1];
		await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${keyC}"] select'); s.value = 'Done'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		const saved = await until(p, `!!document.querySelector('tr[data-step="${keyC}"] [data-saved]')`);
		// as soon as it says Saved, the select shows the saved value (a form reset would put back the old one)
		await sleep(100);
		const immediate = await p.evaluate(`document.querySelector('tr[data-step="${keyC}"] select').value`);
		await p.goto(`${V}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const after = await p.evaluate(`({ value: document.querySelector('tr[data-step="${keyC}"] select').value, imported: document.querySelector('tr[data-step="${keyC}"] [data-imported]')?.textContent.trim() ?? null, others: [...document.querySelectorAll('tr[data-step] select')].map((s) => s.value) })`);
		const stored = savedRows().filter((r) => r.store === 'enforcement-status').map((r) => JSON.parse(r.fields));
		// v2: same case folder, steps reordered; activate it and read the same step
		const v2 = await reorderedCase(join(tmp, 'v2'), main.caseDir);
		const i2 = await A.c.importPkg(main.caseDir, v2.pkgDir);
		await A.c.activate(i2.importId, { ack: true });
		const active2 = (await A.c.activeVersion()) === v2.resultsVersion;
		await p.goto(`${A.v(v2.resultsVersion)}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const inV2 = await p.evaluate(`[...document.querySelectorAll('#main table tbody tr')].map((r) => [r.cells[0].textContent.trim(), r.querySelector('select')?.value ?? null])`);
		// back to v1 as the active version for the remaining scenarios
		const back = await A.c.form(`/v/${encodeURIComponent(v2.resultsVersion)}/overview?/rollback`, { expect: v2.resultsVersion, to: main.resultsVersion });
		const active1 = (await A.c.activeVersion()) === main.resultsVersion;
		return all({
			saved: saved === true, shownAtOnce: immediate === 'Done', reloaded: after.value === 'Done', importedShown: after.imported === 'Imported status: Contingent', othersUnchanged: J(after.others) === J(['To do', 'Done', 'Awaiting counsel']),
			stored: stored.length === 1 && stored[0].stepKey === keyC && stored[0].status === 'Done' && Number.isInteger(stored[0].seq),
			v2Active: active2, followsStep: J(inV2) === J([['Synthetic step C', 'Done'], ['Synthetic step A', 'To do'], ['Synthetic step B', 'Awaiting counsel'], ['Synthetic twin', null], ['Synthetic twin', null]]),
			rolledBack: active1, evidence: { after, stored, inV2, back: back.status },
		});
	});

	await scenario('S2-status-busy', 'enforcement_tab', 'a status change while work.sqlite is locked (BEGIN IMMEDIATE held 13 s): the row shows the error and keeps the chosen value, also while another step saves; after release, choosing again saves it', async () => {
		await p.goto(`${V}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const keyA = keys[0];
		const before = savedRows().filter((r) => r.store === 'enforcement-status').length;
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0');
		lock.exec('BEGIN IMMEDIATE');
		const t0 = Date.now();
		await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${keyA}"] select'); s.value = 'Monitor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		const err = await until(p, `document.querySelector('tr[data-step="${keyA}"] [data-save-error]')?.textContent.trim() ?? ''`, 25000);
		const kept = await p.evaluate(`document.querySelector('tr[data-step="${keyA}"] select').value`);
		const during = savedRows().filter((r) => r.store === 'enforcement-status').length;
		while (Date.now() - t0 < 13000) await sleep(100);
		lock.exec('ROLLBACK'); lock.close();
		const heldMs = Date.now() - t0;
		// another step saves: step A keeps its own error and its unsaved choice
		const keyB = keys[2];
		await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${keyB}"] select'); s.value = 'In progress'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		const savedB = await until(p, `!!document.querySelector('tr[data-step="${keyB}"] [data-saved]')`);
		const stillA = await p.evaluate(`({ error: document.querySelector('tr[data-step="${keyA}"] [data-save-error]')?.textContent.trim() ?? null, value: document.querySelector('tr[data-step="${keyA}"] select').value, saved: !!document.querySelector('tr[data-step="${keyA}"] [data-saved]') })`);
		const aStoredBefore = savedRows().filter((r) => r.store === 'enforcement-status').map((r) => JSON.parse(r.fields)).filter((f) => f.stepKey === keyA).length;
		await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${keyA}"] select'); s.value = 'Monitor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		const saved = await until(p, `!!document.querySelector('tr[data-step="${keyA}"] [data-saved]')`);
		const rows = savedRows().filter((r) => r.store === 'enforcement-status').map((r) => JSON.parse(r.fields)).filter((f) => f.stepKey === keyA);
		return all({ errorVisible: /busy/.test(err ?? ''), keptChoice: kept === 'Monitor', nothingWritten: during === before, heldOver12s: heldMs > 12000,
			otherStepSaved: savedB === true, errorStaysOnItsStep: /busy/.test(stillA.error ?? '') && stillA.value === 'Monitor' && !stillA.saved && aStoredBefore === 0,
			savedAfter: saved === true, oneRow: rows.length === 1 && rows[0].status === 'Monitor', evidence: { err, heldMs, stillA } });
	});

	// ---- 3. legality ------------------------------------------------------------------------------------------------
	await scenario('S3-legality', 'legality_tab', 'a legality scenario and its evidence: likelihood chips by v5 rule, documents linked by ref to their document pages, cleaned titles and the dash for a missing date', async () => {
		await p.goto(`${V}${route('legality_tab')}`, ready('legality_tab'));
		const got = await p.evaluate(`({
			chips: [...document.querySelectorAll('[data-chip]')].map((e) => [e.textContent.trim(), e.dataset.chip]),
			docs: [...document.querySelectorAll('#legality-docs tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())),
			hrefs: [...document.querySelectorAll('#legality-docs a.cite')].map((a) => a.getAttribute('href')),
			intro: document.querySelector('.risk .narrative a.cite')?.getAttribute('href') ?? null })`);
		await p.click('#legality-docs a.cite');
		const opened = await until(p, ready('doc:OD-001'));
		return all({
			chips: J(got.chips) === J([['Base case', 'ok'], ['Material risk', 'danger'], ['Possible', 'warn']]),
			docs: J(got.docs) === J([['OD-001', '2001-02-03', 'Synthetic agreement', 'open ↗'], ['OD-002', '—', 'Synthetic invoice', 'open ↗']]),
			links: J(got.hrefs) === J(['OD-001', 'OD-002'].map((r) => `/v/${encodeURIComponent(main.resultsVersion)}/doc/${r}`)),
			introCitation: got.intro === `/v/${encodeURIComponent(main.resultsVersion)}/doc/OD-001`, documentOpens: opened === true, evidence: got,
		});
	});

	// ---- 4. cause of action -----------------------------------------------------------------------------------------
	await scenario('S4-elements', 'elements_tab', 'trace a cause-of-action element to its witness: the witness as stated (no link), "open →" to the named view with heading focus; an unknown target is text, not a link (S-elements_tab-1)', async () => {
		await p.goto(`${V}${route('elements_tab')}`, ready('elements_tab'));
		const got = await p.evaluate(`({
			witnesses: [...document.querySelectorAll('td[data-witness]')].map((e) => [e.textContent.trim(), !!e.querySelector('a')]),
			targets: [...document.querySelectorAll('#elements-table a[data-target]')].map((a) => [a.dataset.target, a.textContent.trim()]),
			unknown: document.querySelector('[data-unknown-view]')?.textContent.trim() ?? null,
			unknownIsLink: !!document.querySelector('[data-unknown-view]')?.closest('a'),
			columns: [...document.querySelectorAll('#elements-table th')].map((e) => e.textContent.trim()) })`);
		await p.click('#elements-table a[data-target="chronology"]');
		const landed = await until(p, `${ready('chronology')} && document.activeElement?.hasAttribute('data-page-heading')`);
		return all({
			witnessAsStated: J(got.witnesses) === J([['Synthetic Witness One', false], ['Synthetic Witness Two', false]]),
			link: J(got.targets) === J([['chronology', 'open →']]), unknownText: got.unknown === 'no such view: no_such_tab', notALink: !got.unknownIsLink,
			neutralColumns: J(got.columns) === J(['Element', 'What must be proved', 'Evidence', 'Witness', 'Go to']), landed: landed === true, evidence: got,
		});
	});

	// ---- 5. authorities ---------------------------------------------------------------------------------------------
	await scenario('S5-authority', 'authorities_tab', 'create and export an authority: imported rows first, then the user row; an entry without an authority is ignored; the CSV has the header, imported rows unchanged and the user row with its formula neutralised; it persists after reload', async () => {
		await p.goto(`${V}${route('authorities_tab')}`, ready('authorities_tab'));
		const n0 = await count(p, '#auth-table tbody tr');
		await fill(p, { '#au_topic': 'Only a topic' });
		await p.click('#au-add-button');
		await sleep(600);
		const ignored = (await count(p, '#auth-table tbody tr')) === n0 && rowsWhere('authorities', 'topic', 'Only a topic').length === 0;
		await fill(p, { '#au_topic': 'User topic', '#au_auth': 'User authority', '#au_prop': '=1+1' });
		await p.click('#au-add-button');
		const added = await until(p, `document.querySelectorAll('#auth-table tbody tr').length === ${n0 + 1}`);
		const cleared = (await val(p, '#au_auth')) === '';
		await p.goto(`${V}${route('authorities_tab')}`, ready('authorities_tab'));
		const rows = await p.evaluate(`[...document.querySelectorAll('#auth-table tbody tr')].map((r) => [r.dataset.source, ...[...r.cells].map((c) => c.textContent.trim())])`);
		await takeDownloads(p);
		await p.click('#auth-export');
		await sleep(300);
		const dl = await takeDownloads(p);
		const lines = dl[0]?.text.split('\r\n') ?? [];
		return all({
			ignored, added: added === true, cleared,
			order: J(rows.map((r) => r[0])) === J(['imported', 'imported', 'user']) && J(rows[2]) === J(['user', 'User topic', 'User authority', '=1+1']),
			exportName: dl[0]?.name === 'authorities.csv',
			exportRows: lines.length === 4 && lines[0] === 'topic,authority,proposition' && lines[1].startsWith('Synthetic topic 1,Invented v Invented,') && lines[2] === 'Synthetic topic 2,"Invented Act 1 of 2001, s1","Another, with a comma"',
			userCellNeutralised: lines[3]?.startsWith('User topic,User authority,') && !lines[3].endsWith(',=1+1'),
			stored: rowsWhere('authorities', 'authority', 'User authority').length === 1, evidence: { rows, lines },
		});
	});

	// ---- 6. heads -----------------------------------------------------------------------------------------------------
	await scenario('S6-heads', 'heads_tab', 'draft and reload an argument section: the empty state first, then the section numbered with its evidence refs (OD-001 linked, XX-9 and OD-1;SD-2 text), kept after reload', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		const emptyText = await text(p, '#heads-table tbody');
		await fill(p, { '#hd_head': 'Synthetic heading', '#hd_sub': 'Synthetic submission', '#hd_auth': 'Invented authority', '#hd_ref': 'OD-001, XX-9 OD-1;SD-2' });
		await p.click('#hd-add-button');
		const added = await until(p, `document.querySelectorAll('#heads-table tbody tr[data-row]').length === 1`);
		const cleared = (await val(p, '#hd_head')) === '' && (await val(p, '#hd_ref')) === '';
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		const got = await p.evaluate(`({ cells: [...document.querySelector('#heads-table tbody tr[data-row]').cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
			links: [...document.querySelectorAll('#heads-table tbody a.cite')].map((a) => [a.textContent.trim(), a.getAttribute('href')]) })`);
		return all({
			emptyState: emptyText === 'No submissions yet — build your skeleton argument here.', added: added === true, cleared,
			row: J(got.cells.slice(0, 5)) === J(['1', 'Synthetic heading', 'Synthetic submission', 'Invented authority', 'OD-001 XX-9 OD-1;SD-2']),
			links: J(got.links) === J([['OD-001', `/v/${encodeURIComponent(main.resultsVersion)}/doc/OD-001`]]), evidence: got,
		});
	});

	// ---- 7. cross-exam ----------------------------------------------------------------------------------------------
	await scenario('S7-crossexam', 'crossexam_tab', 'prepare a witness cross-examination note: seeds first in data order, the note after them (header Add submits the same form), kept after reload; seeds are not copied into user work', async () => {
		await p.goto(`${V}${route('crossexam_tab')}`, ready('crossexam_tab'));
		const before = await p.evaluate(`[...document.querySelectorAll('#cx-table tbody tr[data-row]')].map((r) => [r.dataset.kind, r.cells[0].textContent.trim()])`);
		const tip = await text(p, '#main p.tag');
		await fill(p, { '#cx_w': 'Seed witness 1', '#cx_t': 'Synthetic follow-up', '#cx_put': 'Put the invented document', '#cx_docs': 'OD-001' });
		await p.click('#cx-add-header');
		const added = await until(p, `document.querySelectorAll('#cx-table tbody tr[data-kind="user"]').length === 1`);
		await fill(p, { '#cx_put': 'Only a put' });
		await p.click('#cx-add-form');
		await sleep(600);
		const ignored = rowsWhere('crossexam', 'put', 'Only a put').length === 0 && (await val(p, '#cx_put')) === 'Only a put';
		await p.goto(`${V}${route('crossexam_tab')}`, ready('crossexam_tab'));
		const after = await p.evaluate(`[...document.querySelectorAll('#cx-table tbody tr[data-row]')].map((r) => [r.dataset.kind, ...[...r.cells].slice(0, 4).map((c) => c.textContent.replace(/\\s+/g, ' ').trim())])`);
		const seedCite = await p.evaluate(`document.querySelector('#cx-table tr[data-kind="seed"] a.cite')?.getAttribute('href') ?? null`);
		return all({
			seedsFirst: J(before) === J([['seed', 'Seed witness 1'], ['seed', 'Seed witness 2']]), tip: tip === viewContentText(main, 'crossexam_tab', 'tip'),
			added: added === true, ignored,
			after: J(after) === J([['seed', 'Seed witness 1', 'Seed topic 1', 'Invented put citing OD-002', 'OD-002'], ['seed', 'Seed witness 2', 'Seed topic 2', 'Invented put 2', ''], ['user', 'Seed witness 1', 'Synthetic follow-up', 'Put the invented document', 'OD-001']]),
			seedCitation: seedCite === `/v/${encodeURIComponent(main.resultsVersion)}/doc/OD-002`,
			notCopied: savedRows().filter((r) => r.store === 'crossexam').length === 1 && overlays().length === 0, evidence: { before, after },
		});
	});

	await scenario('S7-crossexam-delete', 'crossexam_tab', 'deleting an imported topic records a seed overlay {deleted: true} (results unchanged); deleting every topic shows "No cross-exam topics yet."', async () => {
		await p.goto(`${V}${route('crossexam_tab')}`, ready('crossexam_tab'));
		const n = await count(p, '#cx-table tbody tr[data-row]');
		await p.click('#cx-table tbody tr[data-kind="seed"] button');
		await until(p, `document.querySelectorAll('#cx-table tbody tr[data-row]').length === ${n - 1}`);
		const ov = overlays().map((o) => ({ ...o, fields: JSON.parse(o.fields) }));
		for (let i = 0; i < 5 && (await count(p, '#cx-table tbody tr[data-row]')) > 0; i++) {
			const m = await count(p, '#cx-table tbody tr[data-row]');
			await p.click('#cx-table tbody tr[data-row] button');
			await until(p, `document.querySelectorAll('#cx-table tbody tr[data-row]').length === ${m - 1}`);
		}
		await p.goto(`${V}${route('crossexam_tab')}`, ready('crossexam_tab'));
		const emptyText = await text(p, '#cx-table tbody');
		const seedsInResults = A.results(`SELECT count(*) AS n FROM seed WHERE version_id = ? AND dataset_key = 'lit-crossexam-seed'`, main.resultsVersion)[0].n;
		return all({
			overlay: ov.length === 1 && ov[0].case_id === CASE_ID && ov[0].dataset_key === 'lit-crossexam-seed' && ov[0].fields.deleted === true && /^[0-9a-f]{64}$/.test(ov[0].base_seed_sha256),
			emptyState: emptyText === 'No cross-exam topics yet.', overlaysNow: overlays().length === 2, userRowsGone: savedRows().filter((r) => r.store === 'crossexam').length === 0,
			resultsUnchanged: seedsInResults === 2, evidence: { ov, emptyText },
		});
	});

	// ---- 8 and 9. conflict check ------------------------------------------------------------------------------------
	await scenario('S8-conflict-known', 'conflict_tab', 'a known conflict search (the checklist example): picking a person searches by name; "org a" finds the correspondent, then the entity; the input hint holds no e-mail address and no imported value (S-conflict_tab-1)', async () => {
		await p.goto(`${V}${route('conflict_tab')}`, ready('conflict_tab'));
		const ph = await p.evaluate(`document.querySelector('#confq').getAttribute('placeholder')`);
		const options = await p.evaluate(`[...document.querySelector('#confsel').options].map((o) => [o.value, o.textContent])`);
		await p.evaluate(`(() => { const s = document.querySelector('#confsel'); s.value = s.options[2].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		await sleep(100);
		const picked = { q: await val(p, '#confq'), badge: await text(p, '#confres .badge'), rows: await p.evaluate(`[...document.querySelectorAll('#confres tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()))`) };
		await p.type('#confq', 'org a');
		await p.click('#conf-check');
		await sleep(100);
		const typed = { badge: await text(p, '#confres .badge'), kind: await p.evaluate(`document.querySelector('#confres .badge')?.dataset.result`), rows: await p.evaluate(`[...document.querySelectorAll('#confres tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()))`) };
		const imported = ['Ann Lee', 'ann@x.test', 'Org A', 'Org A Ltd', 'supplier', viewContentText(main, 'conflict_tab', 'queryPlaceholder')].filter(Boolean);
		const html = await p.evaluate(`document.querySelector('#main').innerHTML`);
		return all({
			placeholderGeneric: typeof ph === 'string' && ph.length > 0 && !ph.includes('@') && imported.every((v) => !ph.toLowerCase().includes(v.toLowerCase())),
			viewContentPlaceholderNotRendered: !html.includes(viewContentText(main, 'conflict_tab', 'queryPlaceholder')),
			options: J(options) === J([['', '— choose from the matter —'], ['Org A Ltd', 'Org A Ltd — supplier'], ['Ann Lee <ann@x.test>', 'Ann Lee · ann@x.test (Org A)']]),
			pickByName: picked.q === 'Ann Lee' && picked.badge === '1 potential match(es) — review before acting' && J(picked.rows) === J([['Correspondent', 'Ann Lee (ann@x.test)', 'Org A']]),
			known: typed.kind === 'matches' && typed.badge === '2 potential match(es) — review before acting' && J(typed.rows) === J([['Correspondent', 'Ann Lee (ann@x.test)', 'Org A'], ['Entity', 'Org A Ltd', 'supplier']]),
			evidence: { ph, picked, typed },
		});
	});

	await scenario('S9-conflict-unknown', 'conflict_tab', 'an unknown party: v5\'s no-match wording with neutral (not success) styling, the scope disclosure with counts, and no claim of clearance; Enter does not run the check (S-conflict_tab-3, copied)', async () => {
		await p.goto(`${V}${route('conflict_tab')}`, ready('conflict_tab'));
		await p.type('#confq', ' ZZZ ');
		await p.key('Enter');
		await sleep(100);
		const afterEnter = await count(p, '#confres .badge');
		await p.click('#conf-check');
		await sleep(100);
		const got = await p.evaluate(`({ badge: document.querySelector('#confres .badge')?.textContent.trim(), cls: document.querySelector('#confres .badge')?.className, scope: document.querySelector('#conf-scope')?.textContent.trim(), page: document.querySelector('#main').textContent })`);
		return all({
			enterIgnored: afterEnter === 0, wording: got.badge === 'No conflict match found for "zzz"', neutral: /\bneutral\b/.test(got.cls ?? '') && !/\b(ok|success|b-ok)\b/.test(got.cls ?? ''),
			scope: got.scope === "Searches only this matter's 1 person and 1 entity from the imported results package. A match, or no match, is not a conflict clearance.",
			noClearanceClaim: !/\b(cleared|no conflict exists|conflict-free)\b/i.test(got.page), evidence: { badge: got.badge, cls: got.cls, scope: got.scope },
		});
	});

	// ---- 10. export preparation material with valid citations ---------------------------------------------------------
	await scenario('S10-export', 'heads_tab', 'export preparation material: the skeleton TXT starts with the literal heading and the view-content caption, holds the section as typed, and every linked evidence ref opens its document page', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		await takeDownloads(p);
		await p.click('#heads-export');
		await sleep(300);
		const dl = await takeDownloads(p);
		const hrefs = await p.evaluate(`[...document.querySelectorAll('#heads-table a.cite')].map((a) => a.getAttribute('href'))`);
		const pages = [];
		for (const h of hrefs) pages.push((await A.c.get(h)).status);
		await p.click('#heads-table a.cite');
		const opened = await until(p, ready('doc:OD-001'));
		const caption = viewContentText(main, 'heads_tab', 'exportCaption');
		return all({
			name: dl[0]?.name === 'heads_of_argument.txt',
			text: dl[0]?.text === `HEADS OF ARGUMENT — ${caption}\n\n1. Synthetic heading\n   Synthetic submission\n   Authority: Invented authority\n   Evidence: OD-001, XX-9 OD-1;SD-2\n\n`,
			citationsResolve: hrefs.length === 1 && pages.every((s) => s === 200), opened: opened === true, evidence: { name: dl[0]?.name, hrefs, pages },
		});
	});

	// ---- failed writes ----------------------------------------------------------------------------------------------
	await scenario('FAIL-busy', 'crossexam_tab', 'a busy store (BEGIN IMMEDIATE on work.sqlite held 13 s across the submit): the error is visible, every typed field keeps its value, no row is written (with JavaScript, and without it the 503 page re-fills the form); after release one retry saves exactly one row', async () => {
		await p.goto(`${V}${route('crossexam_tab')}`, ready('crossexam_tab'));
		const typed = { '#cx_w': 'Busy witness', '#cx_t': 'Busy topic', '#cx_put': 'Busy put', '#cx_docs': 'OD-002' };
		await fill(p, typed);
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0');
		lock.exec('BEGIN IMMEDIATE');
		const t0 = Date.now();
		// the same add without JavaScript, at the same time: the server answers 503 with the form re-filled
		const noJs = A.c.form(`${V.slice(A.origin.length)}${route('crossexam_tab')}?/add`, { witness: 'NoJS witness', topic: 'NoJS topic', put: 'NoJS put', docs: 'NoJS docs' });
		await p.click('#cx-add-form');
		const err = await until(p, `document.querySelector('#cx-error')?.textContent.trim() ?? ''`, 25000);
		const nj = await noJs;
		const noJsKept = nj.status === 503 && ['NoJS witness', 'NoJS topic', 'NoJS put', 'NoJS docs'].every((v) => nj.text.includes(`value="${v}"`)) && /local store is busy/.test(nj.text);
		const kept = {};
		for (const sel of Object.keys(typed)) kept[sel] = await val(p, sel);
		const during = rowsWhere('crossexam', 'witness', 'Busy witness').length;
		while (Date.now() - t0 < 13000) await sleep(100);
		lock.exec('ROLLBACK'); lock.close();
		const heldMs = Date.now() - t0;
		await p.click('#cx-add-form');
		const saved = await until(p, `[...document.querySelectorAll('#cx-table tbody tr[data-kind="user"]')].some((r) => r.cells[0].textContent.trim() === 'Busy witness') && !document.querySelector('#cx-error')`);
		return all({ errorVisible: /busy/.test(err ?? ''), keptValues: J(kept) === J(typed), noRowWritten: during === 0, heldOver12s: heldMs > 12000, noJsFormRefilled: noJsKept, noJsNotWritten: rowsWhere('crossexam', 'witness', 'NoJS witness').length === 0, retrySaved: saved === true, exactlyOne: rowsWhere('crossexam', 'witness', 'Busy witness').length === 1, evidence: { err, heldMs, noJsStatus: nj.status } });
	});

	await scenario('FAIL-lost', 'heads_tab', 'lost transport (the server stopped before the submit): the error is visible, every typed field keeps its value (also after deleting another row), no row is written; after a restart one retry saves exactly one row', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		// a row to delete later, after the failed add
		await fill(p, { '#hd_head': 'Disposable heading', '#hd_sub': 'Disposable' });
		const n0 = await count(p, '#heads-table tbody tr[data-row]');
		await p.click('#hd-add-button');
		await until(p, `document.querySelectorAll('#heads-table tbody tr[data-row]').length === ${n0 + 1}`);
		const typed = { '#hd_head': 'Lost heading', '#hd_sub': 'Lost submission', '#hd_auth': 'Lost authority', '#hd_ref': 'OD-002' };
		await fill(p, typed);
		await A.stop();
		await p.click('#hd-add-button');
		const err = await until(p, `document.querySelector('#hd-error')?.textContent.trim() ?? ''`, 15000);
		const kept = {};
		for (const sel of Object.keys(typed)) kept[sel] = await val(p, sel);
		await A.start();
		const during = rowsWhere('heads', 'head', 'Lost heading').length;
		// deleting another row after the failed add leaves the typed fields alone
		await p.evaluate(`[...document.querySelectorAll('#heads-table tbody tr[data-row]')].find((r) => r.cells[1].textContent.trim() === 'Disposable heading').querySelector('button').setAttribute('data-del', '1')`);
		await p.click('[data-del="1"]');
		const deleted = await until(p, `![...document.querySelectorAll('#heads-table tbody tr[data-row]')].some((r) => r.cells[1].textContent.trim() === 'Disposable heading')`);
		const keptAfterDelete = {};
		for (const sel of Object.keys(typed)) keptAfterDelete[sel] = await val(p, sel);
		await p.click('#hd-add-button');
		const saved = await until(p, `[...document.querySelectorAll('#heads-table tbody tr[data-row]')].some((r) => r.cells[1].textContent.trim() === 'Lost heading') && !document.querySelector('#hd-error')`);
		return all({ errorVisible: /could not be reached/.test(err ?? ''), keptValues: J(kept) === J(typed), noRowWritten: during === 0, otherDeleteSaved: deleted === true, keptAfterDelete: J(keptAfterDelete) === J(typed), retrySaved: saved === true, exactlyOne: rowsWhere('heads', 'head', 'Lost heading').length === 1, evidence: { err } });
	});

	// ---- restarts ---------------------------------------------------------------------------------------------------
	await scenario('RESTART', 'heads_tab', 'saved rows survive one SIGKILL restart and one graceful restart: every register row and seed overlay compared by id and fields, and the pages show them', async () => {
		const snap = () => J({ rows: savedRows(), overlays: overlays() });
		const before = snap();
		const s = A.srv; A.srv = null;
		const killed = await s.stop('SIGKILL');
		await A.start();
		const afterKill = snap();
		const graceful = await A.stop();
		await A.start();
		const afterGraceful = snap();
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		const shown = await p.evaluate(`[...document.querySelectorAll('#heads-table tbody tr[data-row]')].map((r) => r.dataset.row)`);
		const ids = savedRows().filter((r) => r.store === 'heads' && r.case_id === CASE_ID).map((r) => r.row_id).sort();
		const counts = JSON.parse(before);
		return all({ rowsSaved: counts.rows.length >= 4, killed: killed?.graceful === false || killed?.exit?.sig === 'SIGKILL', afterKill: afterKill === before, gracefulStop: graceful?.graceful === true, afterGraceful: afterGraceful === before, pageShowsRows: J([...shown].sort()) === J(ids) && ids.length === 2, evidence: { rows: counts.rows.length, overlays: counts.overlays.length } });
	});

	// ---- empty states and an empty export ---------------------------------------------------------------------------
	await scenario('EMPTY-states', 'authorities_tab', 'a package whose litigation tables are empty: every litigation view shows a clear empty state and no error; the heads export holds only the heading line and the blank line; the authorities CSV only its header', async () => {
		const got = {};
		for (const v of LIT) {
			const r = await A.c.get(`${VE.slice(A.origin.length)}${v.route}`);
			await p.goto(`${VE}${v.route}`, ready(v.id));
			got[v.id] = { status: r.status, empty: await p.evaluate(`[...document.querySelectorAll('#main .empty, #conf-scope')].map((e) => e.textContent.trim())`) };
		}
		await p.goto(`${VE}${route('heads_tab')}`, ready('heads_tab'));
		await takeDownloads(p);
		await p.click('#heads-export');
		await sleep(300);
		const heads = (await takeDownloads(p))[0];
		await p.goto(`${VE}${route('authorities_tab')}`, ready('authorities_tab'));
		await p.click('#auth-export');
		await sleep(300);
		const auth = (await takeDownloads(p))[0];
		const caption = viewContentText(empty, 'heads_tab', 'exportCaption');
		return all({
			allOk: Object.values(got).every((x) => x.status === 200),
			enforcement: got.enforcement_tab.empty.includes('No enforcement steps in this results package.'),
			legality: got.legality_tab.empty.includes('No documents listed.') && got.legality_tab.empty.includes('No scenarios listed.'),
			elements: got.elements_tab.empty.includes('No elements in this results package.'),
			authorities: got.authorities_tab.empty.some((t) => /^No authorities in this results package yet\./.test(t)),
			heads: got.heads_tab.empty.includes('No submissions yet — build your skeleton argument here.'),
			crossexam: got.crossexam_tab.empty.includes('No cross-exam topics yet.'),
			conflict: got.conflict_tab.empty.some((t) => /0 people and 0 entities/.test(t)),
			headsExport: heads?.text === `HEADS OF ARGUMENT — ${caption}\n\n`,
			authoritiesExport: auth?.text === 'topic,authority,proposition', evidence: got,
		});
	});

	offLoopback = b.events.requests.filter((r) => r.ttype === 'page' && !/^(https?:\/\/(127\.0\.0\.1|[a-z0-9-]+\.localhost)(:\d+)?\/|data:|blob:|about:|chrome-error:)/.test(r.url)).map((r) => r.url.slice(0, 120));
	await scenario('NET-loopback', 'conflict_tab', 'no page of the run requested anything off loopback', async () => ({ pass: offLoopback.length === 0, evidence: { offLoopback } }));
} catch (e) {
	scenarios.push({ id: 'SETUP', view: 'setup', pass: false, title: String(e?.stack ?? e).slice(0, 2000), ms: 0 });
	console.log(`FAIL    SETUP ${String(e?.stack ?? e).slice(0, 2000)}`);
} finally {
	await b?.close?.().catch?.(() => {});
	try { b?.proc?.kill('SIGKILL'); } catch {}
	await A.stop().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}

const ok = offline.pass && scenarios.length > 0 && scenarios.every((s) => s.pass);
writeFileSync(join(OUT, 'summary.json'), J({ suite: 'litigation', ok, offline: offline.pass, ...(ONLY ? { only: [...ONLY] } : {}), bun: bunIdentity(), chromium: CHROME, build: stamp, scenarios: scenarios.map(({ id, view, pass }) => ({ id, view, pass })) }, null, 1));
console.log(`litigation suite: ${scenarios.filter((s) => s.pass).length} PASS, ${scenarios.filter((s) => !s.pass).length} FAIL -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
