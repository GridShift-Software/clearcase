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
const { CASE_ID, LONG_PERSON, NARROW_ID, changedCase, emptyCase, mainCase, narrowCase, neutralCase, pkgData, reorderedCase, viewContentText } = await import('./lib/cases.mjs');
const { EXPORT_NAME_NOTE } = await import('../../../src/lib/local-case/results.server.ts');
const { AUTH_FILE } = await import('../../../src/lib/views/litigation/authorities.ts');
const { HEADS_FILE } = await import('../../../src/lib/views/litigation/heads.ts');

const J = JSON.stringify;
// each view's Source and scope note, in full (UI wording, GRS-18 r2 D11): a changed tail must fail
const ANALYSIS = 'Supplied analysis from the imported results package, shown as supplied. ClearCase has not verified it: check each legal assertion and authority before relying on it.';
const REGISTER = [ANALYSIS, 'Rows you add are your own work, kept on this computer.'];
const NOTES = { enforcement_tab: [ANALYSIS], legality_tab: [ANALYSIS], elements_tab: [ANALYSIS], heads_tab: REGISTER, crossexam_tab: REGISTER, authorities_tab: REGISTER,
	conflict_tab: ["Parties and correspondents as listed in the imported results package, compared as supplied. ClearCase has not checked that the list is complete: search your firm's own conflict records as well."] };
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
/** Type at the end of a field, as a user adding to it (GRS-18 r2: typing while a save is in flight). */
async function append(p, sel, text) { await p.click(sel); await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); e.setSelectionRange(e.value.length, e.value.length); return true; })()`); await p.s('Input.insertText', { text }); }
/** Hold work.sqlite's write lock from outside the app (BEGIN IMMEDIATE); `release()` lets the app's retries through. */
function holdLock() { const db = new Database(join(A.dataDir, 'work.sqlite')); db.exec('PRAGMA busy_timeout=0'); db.exec('BEGIN IMMEDIATE'); return { release: () => { db.exec('ROLLBACK'); db.close(); } }; }
const vals = async (p, sels) => { const o = {}; for (const sel of sels) o[sel] = await val(p, sel); return o; };
/** Wait until `expr` holds or `ms` passes; returns the last value. */
async function until(p, expr, ms = 20000) { try { return await p.waitFor(expr, ms); } catch { return p.evaluate(expr).catch(() => null); } }

// ---- run ---------------------------------------------------------------------------------------------------------
const offline = await proveOffline();
const stamp = existsSync(join(BUILD, 'clearcase-build.json')) ? JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')) : null;
const tmp = mkdtempSync(join(process.env.CLEARCASE_TEST_TMP ?? tmpdir(), 'cc08-e2e-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
// the real launcher's env (BODY_SIZE_LIMIT 65M, which backup uploads need): the 413 the D18 entry gets is the action's own limit
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
	// a register entry left typed makes the leave guard cancel a full navigation (the harness declines beforeunload), so
	// each scenario's goto first discards what the previous one left in the add forms
	const goto0 = p.goto;
	p.goto = async (url, r, t) => {
		await p.evaluate(`(() => { for (const b of document.querySelectorAll('[data-discard]')) b.click(); for (const e of document.querySelectorAll('form[id$="-add"] input:not([type=hidden])')) { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`).catch(() => {});
		return goto0(url, r, t);
	};

	// ---- every view: title, heading, focus after navigation, current entry (BA-14, BA-16, BA-18) --------------------
	for (const v of LIT) {
		await scenario(`NAV-${v.id}`, v.id, `${v.label}: reached from the navigation, heading focused, title '${v.label} · <case> · ClearCase', current entry marked`, async () => {
			await p.goto(`${V}/overview`, ready('overview'));
			await p.click(`#nav-${v.id}`);
			await until(p, `${ready(v.id)} && location.pathname.endsWith(${J(v.route)})`);
			await sleep(80);
			const got = await p.evaluate(`({ path: location.pathname, title: document.title, h1: document.querySelector('h1')?.textContent.trim(), focus: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null, unavailable: !!document.querySelector('[data-unavailable]'), note: [...document.querySelectorAll('.source-note p')].map((e) => e.textContent.trim()) })`);
			return all({ path: got.path.endsWith(v.route), title: got.title === `${v.label} · ${titleName} · ClearCase`, heading: got.h1 === v.label, focus: got.focus, current: got.current === `nav-${v.id}`, available: !got.unavailable, scopeNote: J(got.note) === J(NOTES[v.id]) });
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
	const legalityCaption = (sc, n) => {
		const t = JSON.parse(new TextDecoder().decode(sc.files.get('datasets/view-content.json'))).data?.legality_tab?.docsHeading?.template;
		return Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : String(n))).join('') : null;
	};
	await scenario('S3-legality', 'legality_tab', 'a legality scenario and its evidence: likelihood chips by v5 rule, documents linked by ref to their document pages, cleaned titles and the dash for a missing date', async () => {
		await p.goto(`${V}${route('legality_tab')}`, ready('legality_tab'));
		const got = await p.evaluate(`({
			chips: [...document.querySelectorAll('[data-chip]')].map((e) => [e.textContent.trim(), e.dataset.chip]),
			docs: [...document.querySelectorAll('#legality-docs tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())),
			hrefs: [...document.querySelectorAll('#legality-docs a.cite')].map((a) => a.getAttribute('href')),
			caption: document.getElementById('legality-docs')?.closest('.card')?.querySelector('.chead')?.textContent.trim() ?? null,
			action: document.querySelector('#legality-scenarios thead th:nth-child(4)')?.textContent.trim() ?? null,
			intro: document.querySelector('.risk .narrative a.cite')?.getAttribute('href') ?? null })`);
		await p.click('#legality-docs a.cite');
		const opened = await until(p, ready('doc:OD-001'));
		return all({
			chips: J(got.chips) === J([['Base case', 'ok'], ['Material risk', 'danger'], ['Possible', 'warn']]),
			// the package's view-content wording (GRS-45): the caption template filled with the document count, and the action heading
			caption: got.caption === legalityCaption(main, pkgData(main, 'lit-legality').docs.length), action: got.action === viewContentText(main, 'legality_tab', 'scenarioActionHeading'), docs: J(got.docs) === J([['OD-001', '2001-02-03', 'Synthetic agreement', 'open ↗'], ['OD-002', '—', 'Synthetic invoice', 'open ↗']]),
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
			// the package's view-content names the file (GRS-38); the neutral name and its note are EXPORT-neutral's
			exportName: !!dl[0]?.name && dl[0].name === viewContentText(main, 'authorities_tab', 'exportFileName') && dl[0].name !== AUTH_FILE,
			noExportNote: (await count(p, '[data-export-note]')) === 0,
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
	// ---- Back with unsaved input, then Stay: focus returns to where it was (GRS-18 r3, M2) -----------------------------
	await scenario('FOCUS-back-stay', 'heads_tab', 'Back with a typed register entry, then Stay: the dialog opens, the entry is kept and focus is on the field that had it (not on body)', async () => {
		await p.goto(`${V}/overview`, ready('overview'));
		await p.click('#nav-heads_tab');
		await until(p, ready('heads_tab'));
		await p.type('#hd_head', 'Unsaved heading');
		await p.evaluate('history.back()');
		const asked = await until(p, `!!document.querySelector('#lit-ask')`, 3000);
		await p.click('#lit-ask-stay');
		await sleep(100);
		const got = await p.evaluate(`({ id: document.activeElement?.id ?? null, tag: document.activeElement?.tagName, path: location.pathname, dialog: !!document.querySelector('#lit-ask') })`);
		return all({ asked: asked === true, stayed: got.path.endsWith(route('heads_tab')) && !got.dialog, focusRestored: got.id === 'hd_head', kept: (await val(p, '#hd_head')) === 'Unsaved heading', evidence: got });
	});

	await scenario('FOCUS-back-stay-roadmap', 'enforcement_tab', 'Back with a status save in flight (work.sqlite locked), then Stay: focus is on the status select that was changed; after the lock is released the choice saves', async () => {
		await p.goto(`${V}/overview`, ready('overview'));
		await p.click('#nav-enforcement_tab');
		await until(p, ready('enforcement_tab'));
		const key0 = await p.evaluate(`document.querySelector('#main tr[data-step]').dataset.step`);
		const sel = `tr[data-step="${key0}"] select`;
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0');
		lock.exec('BEGIN IMMEDIATE');
		let released = false;
		const release = () => { if (!released) { released = true; lock.exec('ROLLBACK'); lock.close(); } };
		try {
			await p.evaluate(`(() => { const s = document.querySelector(${J(sel)}); s.focus(); s.value = 'Monitor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
			await sleep(200);
			await p.evaluate('history.back()');
			const asked = await until(p, `!!document.querySelector('#lit-ask')`, 3000);
			await p.click('#lit-ask-stay');
			await sleep(100);
			const got = await p.evaluate(`({ focusIsSelect: document.activeElement === document.querySelector(${J(sel)}), tag: document.activeElement?.tagName, path: location.pathname, dialog: !!document.querySelector('#lit-ask') })`);
			release();
			const saved = await until(p, `!!document.querySelector(${J(`tr[data-step="${key0}"] [data-saved]`)})`, 25000);
			return all({ asked: asked === true, stayed: got.path.endsWith(route('enforcement_tab')) && !got.dialog, focusRestored: got.focusIsSelect, savedAfterRelease: saved === true, evidence: got });
		} finally { release(); }
	});

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
		// the blank option clears the box and the result, as v5 does
		await p.evaluate(`(() => { const s = document.querySelector('#confsel'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		await sleep(100);
		const blank = { q: await val(p, '#confq'), result: await p.evaluate(`document.querySelector('#confres')?.textContent.trim() ?? ''`) };
		const imported = ['Ann Lee', 'ann@x.test', 'Org A', 'Org A Ltd', 'supplier', viewContentText(main, 'conflict_tab', 'queryPlaceholder')].filter(Boolean);
		const html = await p.evaluate(`document.querySelector('#main').innerHTML`);
		// D15: the whole served document and the route's __data.json, not only #main
		const vcPh = viewContentText(main, 'conflict_tab', 'queryPlaceholder');
		const path = `${V.slice(A.origin.length)}${route('conflict_tab')}`;
		const dataRes = await A.c.get(`${path}/__data.json`);
		const served = { html: (await A.c.get(path)).text, dataStatus: dataRes.status, data: dataRes.text };
		return all({
			placeholderGeneric: typeof ph === 'string' && ph.length > 0 && !ph.includes('@') && imported.every((v) => !ph.toLowerCase().includes(v.toLowerCase())),
			viewContentPlaceholderNotRendered: !html.includes(viewContentText(main, 'conflict_tab', 'queryPlaceholder')),
			options: J(options) === J([['', '— choose from the matter —'], ['0', 'Org A Ltd — supplier'], ['1', 'Ann Lee · ann@x.test (Org A)'], ['2', 'Cy Ode · cy@y.test (Other Co)']]),
			placeholderNotServed: !!vcPh && !served.html.includes(vcPh) && served.dataStatus === 200 && !served.data.includes(vcPh),
			pickByName: picked.q === 'Ann Lee' && picked.badge === '1 potential match(es) — review before acting' && J(picked.rows) === J([['Correspondent', 'Ann Lee (ann@x.test)', 'Org A']]),
			known: typed.kind === 'matches' && typed.badge === '2 potential match(es) — review before acting' && J(typed.rows) === J([['Correspondent', 'Ann Lee (ann@x.test)', 'Org A'], ['Entity', 'Org A Ltd', 'supplier']]),
			blankClears: blank.q === '' && blank.result === '',
			evidence: { ph, picked, typed, blank },
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
		const got = await p.evaluate(`(() => { const b = document.querySelector('#confres .badge'); const cs = b ? getComputedStyle(b) : null; const ok = document.createElement('span'); ok.className = 'ok'; document.body.append(ok); const okColor = getComputedStyle(ok).color; ok.remove(); return { badge: b?.textContent.trim(), cls: b?.className, bg: cs?.backgroundColor, color: cs?.color, okColor, scope: document.querySelector('#conf-scope')?.textContent.trim(), page: document.querySelector('#main').textContent }; })()`);
		// D21: Check with nothing to search for says so
		await p.type('#confq', '   ');
		await p.click('#conf-check');
		await sleep(100);
		const emptyMsg = await text(p, '#confres [data-result="empty"]');
		return all({
			enterIgnored: afterEnter === 0, wording: got.badge === 'No conflict match found for "zzz"', neutral: /\bneutral\b/.test(got.cls ?? '') && !/\b(ok|success|b-ok)\b/.test(got.cls ?? ''),
			neutralColours: got.bg === 'rgb(238, 240, 243)' && got.color === 'rgb(34, 34, 34)' && got.color !== got.okColor,
			scope: got.scope === "Searches only this matter's 2 people and 1 entity from the imported results package. A match, or no match, is not a conflict clearance.",
			emptyQuerySaid: emptyMsg === 'Enter a name, firm or e-mail address, or pick a party from the list, then press Check.',
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
			name: !!dl[0]?.name && dl[0].name === viewContentText(main, 'heads_tab', 'exportFileName') && dl[0].name !== HEADS_FILE,
			noExportNote: (await count(p, '[data-export-note]')) === 0,
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

	// ---- lost edits and conflicting writes (GRS-18 r2, D1 to D9, D18) -------------------------------------------------
	const at = (id) => `${V.slice(A.origin.length)}${route(id)}`;
	const setVal = (sel, v) => p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
	const rowButton = (table, cell, textOf) => p.evaluate(`(() => { const r = [...document.querySelectorAll('${table} tbody tr[data-row]')].find((r) => r.cells[${cell}].textContent.trim() === ${J(textOf)}); if (!r) return false; r.querySelector('button').setAttribute('data-pick', '1'); return true; })()`);
	for (const r of [
		{ view: 'heads_tab', form: '#hd-add', add: '#hd-add-button', fields: { '#hd_head': 'Inflight heading', '#hd_sub': 'Inflight submission' }, more: '#hd_sub', store: 'heads', key: 'head', field: 'sub' },
		{ view: 'crossexam_tab', form: '#cx-add', add: '#cx-add-form', fields: { '#cx_w': 'Inflight witness', '#cx_t': 'Inflight topic' }, more: '#cx_t', store: 'crossexam', key: 'witness', field: 'topic' },
		{ view: 'authorities_tab', form: '#au-add', add: '#au-add-button', fields: { '#au_topic': 'Inflight topic', '#au_auth': 'Inflight authority' }, more: '#au_topic', store: 'authorities', key: 'authority', field: 'topic' },
	]) {
		await scenario(`D1-inflight-${r.view}`, r.view, 'text typed while an Add is in flight (store locked 3 s) stays in its field and the row stores what was sent; the Add is busy (disabled, aria-busy, a status) and a second press stores nothing more (D1, D3)', async () => {
			await p.goto(`${V}${route(r.view)}`, ready(r.view));
			await fill(p, r.fields);
			const sent = Object.values(r.fields);
			const lock = holdLock();
			const t0 = Date.now();
			await p.click(r.add);
			await sleep(400);
			const busy = await p.evaluate(`({ disabled: document.querySelector(${J(r.add)}).disabled, aria: document.querySelector(${J(r.form)}).getAttribute('aria-busy'), status: document.querySelector('[data-saving]')?.textContent.trim() ?? null })`);
			await p.click(r.add);
			await p.evaluate(`document.querySelector(${J(r.form)}).requestSubmit(); true`);
			await append(p, r.more, ' typed later');
			while (Date.now() - t0 < 3000) await sleep(50);
			lock.release();
			const done = await until(p, `!document.querySelector('[data-saving]') && [...document.querySelectorAll('tbody tr')].some((t) => t.textContent.includes(${J(sent[0])}))`);
			await sleep(200);
			const after = await vals(p, Object.keys(r.fields));
			const stored = rowsWhere(r.store, r.key, r.store === 'authorities' ? sent[1] : sent[0]).map((x) => JSON.parse(x.fields));
			const moreSent = r.fields[r.more];
			return all({ busy: busy.disabled === true && busy.aria === 'true' && busy.status === 'Saving the entry…', saved: done === true,
				typedKept: after[r.more] === `${moreSent} typed later`, othersCleared: Object.keys(r.fields).filter((k) => k !== r.more).every((k) => after[k] === ''),
				oneRow: stored.length === 1, storedAsSent: stored[0]?.[r.field] === (r.store === 'authorities' ? sent[0] : sent[1]), noError: !(await p.evaluate(`!!document.querySelector('[data-save-error]')`)), evidence: { busy, after, stored } });
		});
	}

	await scenario('D3-repeat-post', 'heads_tab', 'the same Add form posted twice (no JavaScript, a double press) stores one row; another form stores its own (D3)', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		const addId = await p.evaluate(`document.querySelector('#hd-add input[name="addId"]').value`);
		const f = { addId, head: 'Repeat heading', sub: 'Repeat', auth: '', ref: '' };
		const a = await A.c.form(`${at('heads_tab')}?/add`, f), b = await A.c.form(`${at('heads_tab')}?/add`, f);
		const once = rowsWhere('heads', 'head', 'Repeat heading').length;
		await A.c.form(`${at('heads_tab')}?/add`, { ...f, addId: '0000aaaa-1111' });
		return all({ answered: a.status === 200 && b.status === 200, oneRow: once === 1, otherForm: rowsWhere('heads', 'head', 'Repeat heading').length === 2, evidence: { a: a.status, b: b.status } });
	});

	for (const r of [
		{ view: 'heads_tab', table: '#heads-table', cell: 1, err: '#hd-error', add: '#hd-add-button', big: '#hd_sub', other: '#hd_head', seed: { head: 'D2 disposable', sub: 'x', auth: '', ref: '' }, label: 'D2 disposable' },
		{ view: 'crossexam_tab', table: '#cx-table', cell: 1, err: '#cx-error', add: '#cx-add-form', big: '#cx_put', other: '#cx_w', seed: { witness: 'D2 witness', topic: 'D2 disposable', put: '', docs: '' }, label: 'D2 disposable' },
	]) {
		await scenario(`D2-refused-${r.view}`, r.view, "a refused Add's error and entry stay after another row's Delete succeeds (D2)", async () => {
			await A.c.form(`${at(r.view)}?/add`, r.seed);
			await p.goto(`${V}${route(r.view)}`, ready(r.view));
			await p.type(r.other, 'Refused entry');
			await setVal(r.big, 'x'.repeat(70000));
			await p.click(r.add);
			const err = await until(p, `document.querySelector(${J(r.err)})?.textContent.trim() ?? ''`);
			await rowButton(r.table, r.cell, r.label);
			await p.click('[data-pick="1"]');
			const gone = await until(p, `![...document.querySelectorAll('${r.table} tbody tr[data-row]')].some((t) => t.cells[${r.cell}].textContent.trim() === ${J(r.label)})`);
			await sleep(200);
			const still = await p.evaluate(`({ err: document.querySelector(${J(r.err)})?.textContent.trim() ?? null, other: document.querySelector(${J(r.other)}).value, big: document.querySelector(${J(r.big)}).value.length })`);
			return all({ refused: /64 KiB/.test(err ?? ''), deleted: gone === true, errorKept: still.err === err, entryKept: still.other === 'Refused entry' && still.big === 70000, evidence: { err, still: { ...still } } });
		});
	}

	for (const r of [
		{ view: 'heads_tab', store: 'heads', key: 'head', seed: { head: 'D4 row', sub: 'x', auth: '', ref: '' }, typed: { head: 'NoJS kept heading', sub: 'NoJS kept submission', auth: '', ref: '' } },
		{ view: 'crossexam_tab', store: 'crossexam', key: 'witness', seed: { witness: 'D4 row', topic: 't', put: '', docs: '' }, typed: { witness: 'NoJS kept witness', topic: 'NoJS kept topic', put: '', docs: '' } },
	]) {
		await scenario(`D4-nojs-${r.view}`, r.view, 'without JavaScript a Delete posts the add form, so the typed entry comes back with a note that it is not saved (D4)', async () => {
			await A.c.form(`${at(r.view)}?/add`, r.seed);
			const id = rowsWhere(r.store, r.key, 'D4 row')[0]?.row_id;
			const res = await A.c.form(`${at(r.view)}?/delete`, { rowId: id, ...r.typed });
			const values = Object.values(r.typed).filter(Boolean);
			return all({ ok: res.status === 200, deleted: rowsWhere(r.store, r.key, 'D4 row').length === 0, refilled: values.every((v) => res.text.includes(`value="${v}"`)), noted: res.text.includes('Not saved yet: this entry is still only in the form.'), notStored: rowsWhere(r.store, r.key, values[0]).length === 0, evidence: { status: res.status } });
		});
	}

	await scenario('D5-delete-busy', 'heads_tab', "a Delete refused by a busy store shows its own error by its row, in Delete wording, and leaves the add form's entry and slot alone (D5)", async () => {
		await A.c.form(`${at('heads_tab')}?/add`, { head: 'D5 row', sub: 'x', auth: '', ref: '' });
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		await p.type('#hd_head', 'Typed meanwhile');
		await rowButton('#heads-table', 1, 'D5 row');
		const lock = holdLock();
		const t0 = Date.now();
		await p.click('[data-pick="1"]');
		const err = await until(p, `document.querySelector('[data-pick="1"]')?.closest('tr')?.querySelector('[data-delete-error]')?.textContent.trim() ?? ''`, 25000);
		const slot = await p.evaluate(`document.querySelector('#hd-error')?.textContent ?? null`);
		while (Date.now() - t0 < 13000) await sleep(100);
		lock.release();
		return all({ byRow: /^Not deleted: the local store is busy/.test(err ?? ''), addSlotEmpty: slot === null, entryKept: (await val(p, '#hd_head')) === 'Typed meanwhile', rowKept: rowsWhere('heads', 'head', 'D5 row').length === 1, evidence: { err, slot } });
	});

	await scenario('TWO-TAB-delete', 'heads_tab', 'a Delete of a row another tab already deleted says so once, with no error and no error page', async () => {
		await A.c.form(`${at('heads_tab')}?/add`, { head: 'Twice deleted', sub: 'x', auth: '', ref: '' });
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		await A.c.form(`${at('heads_tab')}?/delete`, { rowId: rowsWhere('heads', 'head', 'Twice deleted')[0].row_id });
		await rowButton('#heads-table', 1, 'Twice deleted');
		await p.click('[data-pick="1"]');
		const notice = await until(p, `document.querySelector('[data-delete-notice]')?.textContent.trim() ?? ''`);
		return all({ said: notice === 'This entry was already deleted elsewhere (in another tab or window). Nothing else was changed.', noError: (await count(p, '[data-delete-error]')) === 0, listed: (await until(p, `![...document.querySelectorAll('#heads-table tr[data-row]')].some((t) => t.cells[1].textContent.trim() === 'Twice deleted')`)) === true, evidence: { notice } });
	});

	await scenario('EXPORT-neutral', 'heads_tab', 'a package without view-content export names: Heads of Argument and Authorities export under their neutral names, each with the generic-name note beside its export button', async () => {
		const neutral = await neutralCase(join(tmp, 'neutral'));
		const imp = await A.c.importPkg(neutral.caseDir, neutral.pkgDir);
		if (!imp.importId) throw new Error(`neutral import failed: ${J(imp)}`);
		const VN = A.v(neutral.resultsVersion), got = {};
		for (const [view, button] of [['heads_tab', '#heads-export'], ['authorities_tab', '#auth-export']]) {
			await p.goto(`${VN}${route(view)}`, ready(view));
			await takeDownloads(p);
			await p.click(button);
			await sleep(300);
			const notes = await p.evaluate(`[...document.querySelectorAll('[data-export-note]')].map((e) => ({ text: e.textContent.trim(), besideExport: !!e.closest('.page-actions')?.querySelector(${J(button)}) }))`);
			got[view] = { downloads: (await takeDownloads(p)).map((d) => d.name), notes, field: viewContentText(neutral, view, 'exportFileName') };
		}
		const ok = (view, file) => got[view].field === null && J(got[view].downloads) === J([file]) && J(got[view].notes) === J([{ text: EXPORT_NAME_NOTE, besideExport: true }]);
		return all({ heads: ok('heads_tab', HEADS_FILE), authorities: ok('authorities_tab', AUTH_FILE), evidence: got });
	});

	await scenario('D18-too-large', 'heads_tab', 'an entry over the request size limit (HTTP 413) says it is too large and names the limit, keeps the entry and offers no retry', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		await setVal('#hd_sub', 'y'.repeat(600000));
		await p.click('#hd-add-button');
		const err = await until(p, `document.querySelector('#hd-error')?.textContent.trim() ?? ''`);
		return all({ tooLarge: /too large to send/.test(err ?? '') && /512 KiB/.test(err ?? ''), notLost: !/could not be reached/.test(err ?? ''), kept: (await p.evaluate(`document.querySelector('#hd_sub').value.length`)) === 600000, noRetry: (await count(p, '[data-retry]')) === 0, evidence: { err: err?.slice(0, 200) } });
	});

	await scenario('LEAVE-guard', 'heads_tab', 'leaving a register with an unsaved entry asks first; Stay keeps the entry, Leave goes', async () => {
		await p.goto(`${V}${route('heads_tab')}`, ready('heads_tab'));
		await setVal('#hd_sub', '');
		await p.type('#hd_head', 'Unsaved heading');
		await p.click('#nav-authorities_tab');
		const asked = await until(p, `!!document.querySelector('#lit-ask')`, 3000);
		const stayedPath = await p.evaluate('location.pathname');
		await p.click('#lit-ask-stay');
		await sleep(100);
		const kept = await val(p, '#hd_head');
		await p.click('#nav-authorities_tab');
		await until(p, `!!document.querySelector('#lit-ask')`, 3000);
		await p.click('#lit-ask-leave');
		const left = await until(p, ready('authorities_tab'));
		return all({ asked: asked === true, stayed: stayedPath.endsWith(route('heads_tab')), kept: kept === 'Unsaved heading', left: left === true });
	});

	await scenario('CONFLICT-nojs', 'conflict_tab', 'without JavaScript the check is visibly inert: the served controls are disabled and a note says it needs JavaScript (D7)', async () => {
		const html = (await A.c.get(at('conflict_tab'))).text;
		const disabled = (id) => new RegExp(`<[^>]*id="${id}"[^>]*\\bdisabled\\b`).test(html) || new RegExp(`<[^>]*\\bdisabled\\b[^>]*id="${id}"`).test(html);
		return all({ select: disabled('confsel'), input: disabled('confq'), button: disabled('conf-check'), note: /<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/.test(html) });
	});

	await scenario('D6-nojs-two-steps', 'enforcement_tab', 'without JavaScript the roadmap is one form: one Save stores every changed step, against its shown version (D6)', async () => {
		await p.goto(`${V}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const fields = await p.evaluate(`[...new FormData(document.querySelector('#enf-form'))]`);
		const forms = await p.evaluate(`document.querySelectorAll('form[action="?/status"]').length`);
		const [kA, kC] = [keys[0], keys[1]];
		const changed = fields.map(([k, v]) => [k, k === `status:${kA}` ? 'Contingent' : k === `status:${kC}` ? 'Monitor' : v]);
		const res = await A.c.form(`${at('enforcement_tab')}?/status`, changed);
		const st = (k) => savedRows().filter((r) => r.store === 'enforcement-status').map((r) => JSON.parse(r.fields)).filter((f) => f.stepKey === k);
		return all({ oneForm: forms === 1, ok: res.status === 200, aSaved: J(st(kA).map((f) => f.status)) === J(['Contingent']), cSaved: J(st(kC).map((f) => f.status)) === J(['Monitor']), evidence: { status: res.status } });
	});

	await scenario('D8-D9-changed-version', 'enforcement_tab', 'a saved status a later version no longer offers stays selected (served HTML, labelled) and a no-JS Save keeps it; a step with an empty imported status keeps one row through Done, blank, Done, blank; a change made in another tab is not overwritten silently (D8, D9)', async () => {
		const kB = keys[2];
		await A.c.form(`${at('enforcement_tab')}?/status`, { stepKey: kB, status: 'Awaiting counsel' });
		const v3 = await changedCase(join(tmp, 'v3'), main.caseDir);
		const i3 = await A.c.importPkg(main.caseDir, v3.pkgDir);
		await A.c.activate(i3.importId, { ack: true });
		const V3 = A.v(v3.resultsVersion), at3 = `${V3.slice(A.origin.length)}${route('enforcement_tab')}`;
		const html = (await A.c.get(at3)).text;
		const sel = /<select[^>]*name="status:([0-9a-f]+)"[^>]*>([\s\S]*?)<\/select>/g;
		let servedB = null;
		for (const m of html.matchAll(sel)) if (m[1] === kB) servedB = m[2];
		const optB = servedB && /<option[^>]*>Awaiting counsel \(no longer offered\)<\/option>/.exec(servedB)?.[0];
		await p.goto(`${V3}${route('enforcement_tab')}`, ready('enforcement_tab'));
		const shownB = await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${kB}"] select'); return { value: s.value, label: s.selectedOptions[0]?.textContent }; })()`);
		const form = await p.evaluate(`[...new FormData(document.querySelector('#enf-form'))]`);
		const nojs = await A.c.form(`${at3}?/status`, form);
		const st = (k) => savedRows().filter((r) => r.store === 'enforcement-status').map((r) => JSON.parse(r.fields)).filter((f) => f.stepKey === k);
		const bAfterNoJs = st(kB).map((f) => f.status);
		// D9: step E, imported '', through the UI
		const kE = await p.evaluate(`[...document.querySelectorAll('tr[data-step]')].find((r) => r.cells[0].textContent.trim() === 'Synthetic step E')?.dataset.step`);
		const cycle = [];
		for (const v of ['Done', '', 'Done', '']) {
			await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${kE}"] select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
			cycle.push(await until(p, `!document.querySelector('tr[data-step="${kE}"] [data-saving]') && !!document.querySelector('tr[data-step="${kE}"] [data-saved]') && document.querySelector('tr[data-step="${kE}"] select').value === ${J(v)}`));
		}
		// two tabs: another tab saves step A; this page's choice for A is refused, kept, and saved on Retry
		const kA = keys[0];
		await A.c.form(`${at3}?/status`, { stepKey: kA, status: 'Done' });
		await p.evaluate(`(() => { const s = document.querySelector('tr[data-step="${kA}"] select'); s.value = 'Monitor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		const stale = await until(p, `document.querySelector('tr[data-step="${kA}"] [data-save-error]')?.textContent.trim() ?? ''`);
		const aBetween = st(kA).map((f) => f.status);
		const keptChoice = await p.evaluate(`document.querySelector('tr[data-step="${kA}"] select').value`);
		await p.click(`tr[data-step="${kA}"] [data-retry]`);
		const retried = await until(p, `!!document.querySelector('tr[data-step="${kA}"] [data-saved]')`);
		await A.c.form(`/v/${encodeURIComponent(v3.resultsVersion)}/overview?/rollback`, { expect: v3.resultsVersion, to: main.resultsVersion });
		return all({
			servedSelected: !!optB && /\bselected\b/.test(optB) && /value="Awaiting counsel"/.test(optB), shown: shownB.value === 'Awaiting counsel' && shownB.label === 'Awaiting counsel (no longer offered)',
			noJsKeeps: nojs.status === 200 && J(bAfterNoJs) === J(['Awaiting counsel']),
			cycleSaved: cycle.every((c) => c === true), oneRowE: J(st(kE).map((f) => f.status)) === J(['']),
			staleRefused: /changed elsewhere/.test(stale ?? '') && /“Done”/.test(stale ?? '') && J(aBetween) === J(['Done']) && keptChoice === 'Monitor',
			retrySaved: retried === true && J(st(kA).map((f) => f.status)) === J(['Monitor']), rolledBack: (await A.c.activeVersion()) === main.resultsVersion,
			evidence: { optB, shownB, bAfterNoJs, cycle, stale },
		});
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
		return all({ rowsSaved: counts.rows.length >= 4, killed: killed?.graceful === false || killed?.exit?.sig === 'SIGKILL', afterKill: afterKill === before, gracefulStop: graceful?.graceful === true, afterGraceful: afterGraceful === before, pageShowsRows: J([...shown].sort()) === J(ids) && ids.length >= 2, evidence: { rows: counts.rows.length, overlays: counts.overlays.length } });
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

	// ---- narrow viewports: the 64-character case id and a long party label never widen the document (GRS-18 r3, M1) ----
	await scenario('NARROW-litigation', 'conflict_tab', 'every litigation view at 320 and 390 px, for a case with a 64-character unbroken id and a party with a long unbroken label: the document is exactly the viewport wide (Conflict Check also with the long party picked and its result table shown)', async () => {
		const narrow = await narrowCase(join(tmp, 'narrow'));
		const ni = await A.c.importPkg(narrow.caseDir, narrow.pkgDir);
		if (!ni.importId) throw new Error(`narrow import failed: ${J(ni)}`);
		const N = A.v(narrow.resultsVersion);
		const layouts = {};
		try {
			for (const width of [320, 390]) {
				await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
				for (const v of LIT) {
					await p.goto(`${N}${v.route}`, ready(v.id));
					if (v.id === 'conflict_tab') {
						await p.evaluate(`(() => { const s = document.querySelector('#confsel'); const o = [...s.options].find((o) => o.textContent.includes(${J(LONG_PERSON.email)})); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
						await until(p, `!!document.querySelector('#confres tbody tr')`, 3000);
					}
					await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
					const l = await p.evaluate(`(() => { const de = document.documentElement; return { vw: de.clientWidth, scrollWidth: de.scrollWidth, banner: document.body.innerText.includes(${J(NARROW_ID)}), rows: document.querySelectorAll('#confres tbody tr').length }; })()`);
					layouts[`${width}:${v.id}`] = { ok: l.scrollWidth === width && l.vw === width && (v.id !== 'conflict_tab' || l.rows > 0), ...l };
				}
			}
		} finally { await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {}); }
		return { pass: Object.keys(layouts).length === 2 * LIT.length && Object.values(layouts).every((x) => x.ok), evidence: layouts };
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
