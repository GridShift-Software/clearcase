#!/usr/bin/env bun
// Offline browser suite of the analysis views (GRS-15, CC-05), run by `bun run --bun test:e2e` after the pilot suites,
// in its own network namespace. It starts the production entry (tests/e2e/pilot/lib/server.mjs through the pilot's
// restartable appServer) on a fresh data directory, imports synthetic packages built by GRS-10's converter, and drives
// Matter & Strategy, Timeline, Contradiction Tracker, Risk Matrix, Defence & Rebuttal, Info Required and Witnesses in
// Chromium. Every view's scenario checks its document title and that the heading has focus after navigation.
// Results: $CLEARCASE_E2E_OUT/analysis/<scenario>.json, summary.json ({scenarios: [{id, view, pass}]}) and the BA-21
// screenshots under screens/. Exit 0 only when the run is offline and every scenario passes.
process.env.CANARY_PORT ??= '43599';
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { CHROME, launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { startCanary } = await import('../pilot/lib/canary.mjs');
const { bunIdentity } = await import('../pilot/lib/server.mjs');
const { appServer } = await import('../pilot/suite/context.mjs');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');
const { pageTitle } = await import('../../../src/lib/components/titles.ts');
const L = await import('./lib.mjs');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = join(ROOT, 'build');
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'analysis');
const SCREENS = join(OUT, 'screens');
mkdirSync(SCREENS, { recursive: true });
const PORT = 43500, ORIG_PORT = 43501;
const label = (id) => VIEWS.find((v) => v.id === id).label;
const route = (id) => VIEWS.find((v) => v.id === id).route;
const J = JSON.stringify;

const scenarios = [];
/** Time windows of the failed-write and restart scenarios: only there may the browser log failed requests (nothing else). */
const noisy = [];
async function scenario(id, view, title, fn, { expectsFailures = false } = {}) {
	const t0 = Date.now();
	if (expectsFailures) noisy.push({ from: t0, to: Infinity });
	let pass = false, evidence = {};
	try { const r = await fn(); pass = r.pass === true; evidence = r.evidence ?? r; }
	catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	if (expectsFailures) noisy.at(-1).to = Date.now() + 500;
	scenarios.push({ id, view, pass });
	writeFileSync(join(OUT, `${id}.json`), J({ id, view, title, pass, ms: Date.now() - t0, evidence }, null, 1));
	console.log(`${pass ? 'PASS   ' : 'FAIL   '} ${id} [${view}] ${title}`);
}

const offline = await proveOffline();
const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-analysis-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
let canary, b;
const A = appServer({ name: 'analysis', root: ROOT, buildDir: BUILD, port: PORT, origPort: ORIG_PORT, dir: tmp });
const ctx = {};

/** Import and activate a package through the app's own forms; returns the active results version. */
async function importActivate(sc) {
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	if (!imp.importId) throw new Error(`import refused: ${imp.status} ${imp.text?.slice(0, 300)}`);
	const act = await A.c.activate(imp.importId);
	if (act.status !== 303) throw new Error(`activation refused: ${J(act)}`);
	return sc.resultsVersion;
}

/**
 * Arrive at a view the way a user does, from the overview through its navigation link, and read what BA-14 and BA-16
 * require: the document title '<label> · <case> · ClearCase' and the focus on the page heading, which is the label.
 */
async function arrive(p, vid, view, caseName) {
	await p.goto(`/v/${encodeURIComponent(vid)}/overview`, L.ready('overview'));
	await p.click(`#nav-${view}`);
	await p.waitFor(`${L.ready(view)} && location.pathname.endsWith(${J(route(view))})`, 30000);
	await sleep(80);
	const got = await p.evaluate(`({ title: document.title, heading: document.querySelector('h1[data-page-heading]')?.textContent.trim() ?? null, focused: document.activeElement?.matches?.('h1[data-page-heading]') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null })`);
	const want = { title: pageTitle({ section: label(view), caseName }), heading: label(view), focused: true, current: `nav-${view}` };
	return { ok: J(got) === J(want), got, want };
}
const V = (vid, view) => `/v/${encodeURIComponent(vid)}${route(view)}`;
const errorsSince = (mk) => b.since(mk).console.filter((c) => c.kind === 'exception' || /error/i.test(c.kind));

try {
	if (!offline.pass) throw new Error(`not offline: ${J(offline)}`);
	canary = await startCanary();
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	await A.start();
	const t0 = Date.now();
	const main = await L.buildCase(join(tmp, 'main'), { caseId: 'e2e-analysis', edit: L.analysisData });
	const empty = await L.buildCase(join(tmp, 'empty'), { caseId: 'e2e-analysis-empty', edit: L.emptyAnalysis });
	const novc = await L.buildCaseWithoutViewContent(join(tmp, 'novc'), { caseId: 'e2e-analysis-novc', edit: L.analysisData });
	const vid = await importActivate(main);
	const caseName = (sc) => { const m = JSON.parse(new TextDecoder().decode(sc.files.get('manifest.json'))); return L.viewContentText(sc, '_shell', 'documentTitle') ?? (m.case.label || m.case.id); };
	const name = caseName(main);
	const p = await L.appPage(b, A.origin);
	ctx.p = p;

	await scenario('AN-01', 'matter', 'Scenario 1: a fixed narrative section reads as the package has it (headings and paragraphs in data order)', async () => {
		const nav = await arrive(p, vid, 'matter', name);
		await p.shot(join(SCREENS, 'matter-desktop.png'));
		const got = await p.evaluate(`[...document.querySelectorAll('#matter-storyline-card h3, #matter-strategy-card h3')].map((h) => [h.textContent.trim(), h.nextElementSibling?.textContent.replace(/\\s+/g, ' ').trim()])`);
		const want = [['Start', 'The agreement OD-001 began the relationship; see also ZZ-404.'], ['Second step', 'A second invented paragraph.'], ['Plan', 'Rely on OD-002 p.2.']];
		const subtitle = await p.evaluate(`document.querySelector('.page-head .subtitle')?.textContent ?? null`);
		return { pass: nav.ok && J(got.map((x) => x[0])) === J(want.map((x) => x[0])) && got[0][1].includes('The agreement') && got[1][1] === want[1][1] && subtitle === 'Synthetic matter', evidence: { nav, got, subtitle } };
	});

	await scenario('AN-02', 'matter', 'Scenario 2: follow an inline [[REF]] citation to its document, Back returns with the heading focused; a missing ref renders broken, never as a link', async () => {
		await p.goto(V(vid, 'matter'), L.ready('matter'));
		const broken = await p.evaluate(`[...document.querySelectorAll('#matter-storyline-card .cite-broken')].map((e) => e.textContent.trim())`);
		const brokenLinks = await p.evaluate(`[...document.querySelectorAll('#matter-storyline-card a')].filter((a) => a.textContent.includes('ZZ-404')).length`);
		const href = await p.evaluate(`document.querySelector('#matter-storyline-card a.cite')?.getAttribute('href')`);
		await p.click('#matter-storyline-card a.cite');
		await p.waitFor(`location.pathname.endsWith('/doc/OD-001') && document.querySelector('main#main')?.dataset.ready === 'doc:OD-001'`, 30000);
		await p.evaluate('history.back()');
		await p.waitFor(L.ready('matter'), 30000);
		await sleep(150);
		const focused = await p.evaluate(`document.activeElement?.matches?.('h1[data-page-heading]') ?? false`);
		return { pass: broken.length === 1 && broken[0].includes('ZZ-404') && brokenLinks === 0 && /\/doc\/OD-001$/.test(href ?? '') && focused, evidence: { broken, brokenLinks, href, focused } };
	});

	await scenario('AN-03', 'timeline', 'Scenario 3: the timeline reads in order: phases, their events by date, titles shown once, the empty phase and events outside every phase', async () => {
		const nav = await arrive(p, vid, 'timeline', name);
		await p.shot(join(SCREENS, 'timeline-desktop.png'));
		const phases = await p.evaluate(`[...document.querySelectorAll('#phases .ph')].map((ph) => ({ title: ph.querySelector('h3')?.textContent.trim(), events: [...ph.querySelectorAll('.ev')].map((e) => ({ date: e.querySelector('.d')?.textContent ?? null, link: e.querySelector('a.cite')?.textContent.trim() ?? null, href: e.querySelector('a.cite')?.getAttribute('href') ?? null, ex: e.querySelector('.ex')?.textContent ?? null })) }))`);
		const want = [
			{ title: 'Phase one', dates: ['2001-02-03', '2001-03-01'], links: ['Agreement & schedule <signed> ↗', 'First invoice ↗'] },
			{ title: 'Phase two', dates: ['2002-05-05'], links: ["Second 'letter' ↗"] },
			{ title: 'Quiet phase', dates: [null], links: [null] },
			{ title: 'Outside every phase', dates: [''], links: ['Undated invented event ↗'] },
		];
		const shaped = phases.map((ph) => ({ title: ph.title, dates: ph.events.map((e) => e.date), links: ph.events.map((e) => e.link) }));
		const text = await p.evaluate(`document.querySelector('#phases').textContent`);
		const years = await p.evaluate(`[...document.querySelectorAll('#years .year')].map((y) => y.querySelector('.bar rect').getBBox().height)`);
		const source = await p.evaluate(`[...document.querySelectorAll('#synopsis .callout a.cite')].map((a) => a.getAttribute('href'))`);
		const ok = nav.ok && J(shaped) === J(want) && !/&amp;|&lt;|&#/.test(text) && phases[2].events[0].ex?.length > 0 && J(years) === J([100, 43, 14]) && phases[0].events[0].href?.endsWith('/doc/OD-001');
		return { pass: ok, evidence: { nav, shaped, years, source } };
	});

	await scenario('AN-04', 'timeline', 'Scenario 4: Print / PDF prints the timeline: window.print is called, and printed output hides the shell and keeps every phase and event; Full chronology opens the chronology', async () => {
		await p.goto(V(vid, 'timeline'), L.ready('timeline'));
		await p.prints();
		await p.click('#print');
		await sleep(100);
		const prints = await p.prints();
		await p.media('print');
		const shown = await p.evaluate(`({ nav: getComputedStyle(document.querySelector('nav.views')).display, header: getComputedStyle(document.querySelector('header.top') ?? document.body).display, actions: getComputedStyle(document.querySelector('.page-actions')).display, phases: document.querySelector('#phases').getClientRects().length > 0, events: [...document.querySelectorAll('#phases .ev')].filter((e) => e.getClientRects().length).length, heading: document.querySelector('h1').getClientRects().length > 0 })`);
		const pdf = await p.s('Page.printToPDF', { printBackground: false });
		await p.media('');
		writeFileSync(join(SCREENS, 'timeline-print.pdf'), Buffer.from(pdf.data, 'base64'));
		// v5's other page action: Full chronology opens the chronology
		await p.click('#full-chronology');
		await p.waitFor(`${L.ready('chronology')} && location.pathname.endsWith('/chronology')`, 30000);
		const ok = prints === 1 && shown.nav === 'none' && shown.header === 'none' && shown.actions === 'none' && shown.phases && shown.events === 5 && shown.heading && pdf.data.length > 1000;
		return { pass: ok, evidence: { prints, shown, pdfBytes: Math.round(pdf.data.length * 0.75), pdf: 'screens/timeline-print.pdf', fullChronology: 'opened' } };
	});

	await scenario('AN-05', 'contradictions_tab', 'Scenario 5: contradiction categories with their severities, item counts and source chips; a chip opens its document; Export CSV has v5 columns', async () => {
		const nav = await arrive(p, vid, 'contradictions_tab', name);
		await p.shot(join(SCREENS, 'contradictions_tab-desktop.png'));
		const cats = await p.evaluate(`[...document.querySelectorAll('section.category')].map((s) => ({ sev: s.querySelector('.chead .badge').textContent, title: s.querySelector('.ctitle').textContent, count: s.querySelector('.count').textContent, chips: [...s.querySelectorAll('.chips a.cite')].map((a) => [a.textContent.trim(), a.getAttribute('href').replace(/^.*\\/doc\\//, '')]) }))`);
		const kpis = await p.evaluate(`[...document.querySelectorAll('.an-kpis .kpi')].map((k) => k.querySelector('.v').textContent)`);
		const checks = await p.evaluate(`[...document.querySelectorAll('#checks-table tbody tr')].map((r) => ['b-ok', 'b-dang', 'b-warn', 'b-info', 'b-mut'].find((c) => r.querySelector('.badge')?.classList.contains(c)) ?? 'text')`);
		await p.click('#export-csv');
		await sleep(80);
		const dl = await p.downloads();
		const lines = dl[0]?.text.split('\r\n') ?? [];
		await p.click('section.category a.cite');
		await p.waitFor(`location.pathname.endsWith('/doc/OD-002') && document.querySelector('main#main')?.dataset.ready === 'doc:OD-002'`, 30000);
		const ok = nav.ok && J(cats.map((c) => c.sev)) === J(['HIGH', 'HIGH', 'LOW', 'INFO']) && J(cats.map((c) => c.count)) === J(['2 item(s)', '1 item(s)', '1 item(s)', '0 item(s)'])
			&& J(cats[0].chips) === J([['OD-002 · R 100.00', 'OD-002'], ['OD-001', 'OD-001']]) && J(kpis) === J(['4', '3', '2', '1']) && J(checks) === J(['b-ok', 'b-dang', 'text', 'b-dang'])
			&& dl[0]?.name === 'contradictions.csv' && lines[0] === 'category,severity,item,detail,spread,refs' && lines.length === 5 && lines[4] === 'Invented duplicate,low,INV-1,Same number,3,OD-001';
		return { pass: ok, evidence: { nav, cats, kpis, checks, csv: { name: dl[0]?.name, lines: lines.length, head: lines[0] } } };
	});

	await scenario('AN-06', 'risk_matrix_tab', 'Scenario 6 and BA-21: one risk with its mitigation reads on a 320 px screen; Risk Matrix, Defence & Rebuttal, Contradiction Tracker, Timeline and Matter do not scroll sideways at 320 and 390 px with long badge values, chips and URLs, and keep their tables at 1280 px (screenshots)', async () => {
		const nav = await arrive(p, vid, 'risk_matrix_tab', name);
		const out = { nav, widths: {} };
		let ok = nav.ok;
		for (const view of ['risk_matrix_tab', 'vdm_matrix_tab', 'contradictions_tab', 'timeline', 'matter']) {
			for (const w of [320, 390, 1280]) {
				await p.viewport(w);
				await p.goto(V(vid, view), L.ready(view));
				await sleep(120);
				const m = await p.evaluate(`(() => { const de = document.documentElement; const main = document.querySelector('main#main'); const tables = [...main.querySelectorAll('table')]; const over = [...main.querySelectorAll('td, th, p, h1, h2, a, span')].filter((e) => !e.closest('thead') && e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).length;
					const longValues = [${J(L.LONG_URL)}, ${J(L.LONG_BADGE)}, ${J(L.TOKEN)}].filter((v) => main.textContent.includes(v)).length;
					return { innerWidth, docScroll: de.scrollWidth, mainScroll: main.scrollWidth, mainClient: main.clientWidth, over, longValues, tableDisplay: tables.map((t) => getComputedStyle(t).display), theadHidden: tables.map((t) => t.tHead ? t.tHead.getBoundingClientRect().width <= 1 : null) }; })()`);
				await p.shot(join(SCREENS, `${view}-${w}.png`));
				const narrow = w < 640;
				const fits = m.docScroll <= m.innerWidth && m.mainScroll <= m.mainClient + 1 && m.over === 0 && m.longValues > 0;
				const layout = narrow ? m.tableDisplay.every((d) => d === 'block') : m.tableDisplay.every((d) => d === 'table');
				out.widths[`${view}@${w}`] = { ...m, fits, layout };
				// at 1280 px a table may scroll inside its card, but the page itself never scrolls sideways
				if (!(narrow ? fits && layout : layout && m.docScroll <= m.innerWidth)) ok = false;
			}
		}
		await p.viewport(320);
		await p.goto(V(vid, 'risk_matrix_tab'), L.ready('risk_matrix_tab'));
		const risk = await p.evaluate(`(() => { const r = document.querySelector('#risk-table tbody tr'); const cell = (l) => [...r.cells].find((c) => c.dataset.label === l); const m = cell('Mitigation'); const box = m.getBoundingClientRect(); return { label: getComputedStyle(m, '::before').content, visible: box.width > 100 && box.right <= innerWidth, text: m.textContent.slice(0, 40), likelihood: cell('Likelihood').textContent.trim(), tone: cell('Likelihood').querySelector('.badge').className }; })()`);
		await p.s('Emulation.clearDeviceMetricsOverride');
		ok = ok && risk.label === '"Mitigation"' && risk.visible && risk.likelihood === 'High' && /b-dang/.test(risk.tone);
		return { pass: ok, evidence: { ...out, risk, screenshots: 'screens/<view>-<width>.png' } };
	});

	await scenario('AN-07', 'vdm_matrix_tab', 'Scenario 7: trace a defence to its evidence: document chips open their documents; the free-text refs are shown and exported after v5 columns (S-vdm_matrix_tab-1)', async () => {
		const nav = await arrive(p, vid, 'vdm_matrix_tab', name);
		await p.shot(join(SCREENS, 'vdm_matrix_tab-desktop.png'));
		const rows = await p.evaluate(`[...document.querySelectorAll('#defence-table tbody tr')].map((r) => ({ chips: [...r.querySelectorAll('.chips a.cite')].map((a) => a.textContent.trim()), dash: r.cells[3].textContent.trim(), refs: r.cells[5]?.textContent.trim() ?? null }))`);
		const heads = await p.evaluate(`[...document.querySelectorAll('#defence-table thead th')].map((t) => t.textContent.trim())`);
		await p.click('#export-csv');
		await sleep(80);
		const dl = await p.downloads();
		const lines = dl[0]?.text.split('\r\n') ?? [];
		await p.click('#defence-table .chips a.cite');
		await p.waitFor(`location.pathname.endsWith('/doc/OD-001') && document.querySelector('main#main')?.dataset.ready === 'doc:OD-001'`, 30000);
		const ok = nav.ok && J(rows[0].chips) === J(['OD-001', 'OD-002']) && rows[1].dash === '—' && rows[0].refs === 'OD-001 – OD-002' && rows[1].refs === '' && heads.length === 6 && heads[5] === 'Refs'
			&& dl[0]?.name === 'defence_rebuttal.csv' && lines[0] === 'dcs_point,dcs_case,ess_evidence,documents,rebuttal,refs' && lines[1].endsWith(',OD-001 – OD-002') && lines[2] === 'Point without documents,Invented case,Invented evidence,,Invented rebuttal,';
		return { pass: ok, evidence: { nav, rows, heads, csv: { name: dl[0]?.name, head: lines[0], rows: lines.length - 1 } } };
	});

	const infoRows = () => A.work("SELECT row_id, fields FROM register_row WHERE case_id = 'e2e-analysis' AND store = 'info-required' ORDER BY row_id").map((r) => ({ id: r.row_id, fields: JSON.parse(r.fields) }));
	const infoState = () => p.evaluate(`[...document.querySelectorAll('#info-table tbody tr')].map((r) => [r.querySelector('input[type=checkbox]').checked, r.cells[1].classList.contains('struck')])`);
	const saved = () => p.waitFor(`!document.querySelector('#info-table [aria-busy="true"]')`, 30000);
	/**
	 * The unsaved items the alert names, each with its own Retry, and each row's visible save marker. The readers fall
	 * back to the single alert of the earlier markup, so these scenarios show the behaviour, not only the markup, when
	 * run against an earlier revision.
	 */
	const infoProblems = () => p.evaluate(`[...(document.querySelector('#info-error .info-problem') ? document.querySelectorAll('#info-error .info-problem') : document.querySelectorAll('#info-error'))].map((e) => ({ text: e.textContent, retry: !!e.querySelector('button') }))`);
	const rowMarks = () => p.evaluate(`[...document.querySelectorAll('#info-table tbody tr')].map((r) => { const m = r.querySelector('.row-state'); return m && m.getClientRects().length ? m.dataset.state : null; })`);
	const retry = async (item) => (await p.click(`#info-error .info-retry[aria-label=${J(`Retry: ${item}`)}]`)) || p.click('#info-retry');
	const errorNames = (item) => p.waitFor(`(document.querySelector('#info-error')?.textContent ?? '').includes(${J(item)})`, 30000);
	const names = (problems, item) => problems.filter((x) => x.text.includes(item)).length === 1 && problems.find((x) => x.text.includes(item)).retry;
	const doneOf = (rows, item) => rows.find((r) => r.fields.item === item)?.fields.done;
	/** A stopped server is always started again, so a failing scenario does not take the next ones down with it. */
	const restarted = async () => { if (!A.srv) await A.start(); };

	await scenario('AN-08', 'info_required_tab', 'Scenario 8: check an information-required item, reload: it stays checked and struck through; the flag is one row keyed by the item, not its position; unchecking persists too', async () => {
		const nav = await arrive(p, vid, 'info_required_tab', name);
		await p.shot(join(SCREENS, 'info_required_tab-desktop.png'));
		await p.click('#info-table tbody tr:nth-child(2) input[type=checkbox]');
		await saved();
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const afterCheck = await infoState();
		const rows1 = infoRows();
		await p.click('#info-table tbody tr:nth-child(2) input[type=checkbox]');
		await saved();
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const afterUncheck = await infoState();
		const rows2 = infoRows();
		const ok = nav.ok && J(afterCheck) === J([[false, false], [true, true], [false, false]]) && rows1.length === 1 && /^info:[0-9a-f]{32}$/.test(rows1[0].id) && rows1[0].fields.item === 'Invented item B' && rows1[0].fields.done === true
			&& J(afterUncheck) === J([[false, false], [false, false], [false, false]]) && rows2.length === 1 && rows2[0].id === rows1[0].id && rows2[0].fields.done === false;
		return { pass: ok, evidence: { nav, afterCheck, afterUncheck, rows: rows2.length } };
	});

	await scenario('AN-FW1', 'info_required_tab', 'Failed write, busy store: a save during a held write lock shows the error, keeps the choice and writes nothing; after release one Retry saves exactly one row', async () => {
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const before = infoRows();
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0');
		lock.exec('BEGIN IMMEDIATE');
		const t0 = Date.now();
		let released = false;
		const release = () => { if (!released) { released = true; lock.exec('ROLLBACK'); lock.close(); } };
		try {
			await p.click('#info-table tbody tr:nth-child(1) input[type=checkbox]');
			// while the store retries, the row shows that it is saving (visible text, not only aria-busy)
			const busyShown = await p.waitFor(`(() => { const r = document.querySelector('#info-table tbody tr:nth-child(1)'); const m = r?.querySelector('.row-state[data-state="saving"]'); return r?.getAttribute('aria-busy') === 'true' && !!m && m.getClientRects().length > 0 && m.textContent.trim() === 'Saving…'; })()`, 10000).then(() => true, () => false);
			await p.waitFor(`document.querySelector('#info-error')`, 30000);
			const error = await p.evaluate(`document.querySelector('#info-error').textContent`);
			const kept = await infoState();
			await sleep(Math.max(0, 12500 - (Date.now() - t0)));
			const during = infoRows();
			release();
			const heldMs = Date.now() - t0;
			await retry('Invented item A');
			await saved();
			await p.waitFor(`!document.querySelector('#info-error')`, 15000);
			const after = infoRows();
			const added = after.filter((r) => !before.some((x) => x.id === r.id));
			const ok = busyShown && /Not saved/.test(error) && kept[0][0] === true && J(during) === J(before) && heldMs > 12000 && added.length === 1 && added[0].fields.item === 'Invented item A' && added[0].fields.done === true && after.length === before.length + 1;
			return { pass: ok, evidence: { busyShown, error: error.slice(0, 160), kept: kept[0], heldMs, rowsBefore: before.length, rowsDuring: during.length, rowsAfter: after.length } };
		} finally { release(); }
	}, { expectsFailures: true });

	await scenario('AN-FW2', 'info_required_tab', 'Failed write, lost transport: with the server stopped a save shows the error and keeps the choice; after a restart one Retry saves exactly one row', async () => {
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const before = infoRows();
		await A.stop();
		await p.click('#info-table tbody tr:nth-child(3) input[type=checkbox]');
		await p.waitFor(`document.querySelector('#info-error')`, 30000);
		const error = await p.evaluate(`document.querySelector('#info-error').textContent`);
		const kept = await infoState();
		await A.start();
		const during = infoRows();
		await retry('Invented item C');
		await saved();
		await p.waitFor(`!document.querySelector('#info-error')`, 15000);
		const after = infoRows();
		const added = after.filter((r) => !before.some((x) => x.id === r.id));
		const ok = /could not be reached/.test(error) && kept[2][0] === true && J(during) === J(before) && added.length === 1 && added[0].fields.item === 'Invented item C' && after.length === before.length + 1;
		return { pass: ok, evidence: { error: error.slice(0, 160), kept: kept[2], rowsBefore: before.length, rowsAfter: after.length } };
	}, { expectsFailures: true });

	await scenario('AN-RS', 'info_required_tab', 'Restarts: after a SIGKILL restart and a graceful restart every saved flag row is unchanged (id and fields) and the page shows the same state', async () => {
		const before = infoRows();
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const shownBefore = await infoState();
		const kill = await A.srv.stop('SIGKILL');
		await A.start();
		const afterKill = infoRows();
		const graceful = await A.stop();
		await A.start();
		const afterGraceful = infoRows();
		await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
		const shownAfter = await infoState();
		const ok = before.length === 3 && J(afterKill) === J(before) && J(afterGraceful) === J(before) && J(shownAfter) === J(shownBefore) && graceful?.graceful === true;
		return { pass: ok, evidence: { rows: before.length, kill: { graceful: kill?.graceful }, graceful: graceful?.graceful, shownBefore, shownAfter } };
	}, { expectsFailures: true });

	await scenario('AN-FW3', 'info_required_tab', 'Two failed saves in a row: each item keeps its choice, its own error and Retry (listed in table order); one Retry saves only its item and leaves the other failure; the second Retry saves it; a reload shows the stored truth', async () => {
		try {
			await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
			const before = infoRows();
			const shownBefore = await infoState();
			await A.stop();
			await p.click('#info-table tbody tr:nth-child(2) input[type=checkbox]');
			await errorNames('Invented item B');
			await p.click('#info-table tbody tr:nth-child(1) input[type=checkbox]');
			await errorNames('Invented item A');
			await sleep(200);
			const failed = { problems: await infoProblems(), marks: await rowMarks(), shown: await infoState() };
			await A.start();
			await retry('Invented item B');
			const settledFirst = await saved().then(() => true, () => false);
			await sleep(300);
			const oneRetried = { problems: await infoProblems(), marks: await rowMarks(), shown: await infoState(), rows: infoRows() };
			await retry('Invented item A');
			const settledSecond = await saved().then(() => true, () => false);
			await sleep(300);
			const after = { rows: infoRows(), error: await p.evaluate(`!!document.querySelector('#info-error')`) };
			await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
			const reloaded = { shown: await infoState(), marks: await rowMarks(), error: await p.evaluate(`!!document.querySelector('#info-error')`) };
			const checks = {
				start: J(shownBefore) === J([[true, true], [false, false], [true, true]]),
				bothFailuresNamedWithRetry: failed.problems.length === 2 && names(failed.problems, 'Invented item A') && names(failed.problems, 'Invented item B') && /\(not done: Invented item A\)/.test(failed.problems[0].text) && failed.problems.every((x) => /could not be reached/.test(x.text)),
				bothRowsMarkedUnsaved: J(failed.marks) === J(['unsaved', 'unsaved', null]) && J(failed.shown) === J([[false, false], [true, true], [true, true]]),
				noRowLeftBusy: settledFirst && settledSecond,
				retryOfOneKeepsTheOther: oneRetried.problems.length === 1 && names(oneRetried.problems, 'Invented item A') && J(oneRetried.marks) === J(['unsaved', null, null]) && J(oneRetried.shown) === J(failed.shown),
				retryOfOneSavesOnlyIt: doneOf(oneRetried.rows, 'Invented item B') === true && doneOf(oneRetried.rows, 'Invented item A') === true,
				secondRetrySaves: doneOf(after.rows, 'Invented item A') === false && doneOf(after.rows, 'Invented item B') === true && after.rows.length === before.length && !after.error,
				reloadShowsStored: J(reloaded.shown) === J([[false, false], [true, true], [true, true]]) && J(reloaded.marks) === J([null, null, null]) && !reloaded.error,
			};
			return { pass: Object.values(checks).every(Boolean), evidence: { checks, shownBefore, failed, oneRetried: { ...oneRetried, rows: oneRetried.rows.length }, rowsAfter: after.rows.length, reloaded } };
		} finally { await restarted(); }
	}, { expectsFailures: true });

	await scenario('AN-FW4', 'info_required_tab', 'A failed save, then a successful save of another item: the failed item keeps its choice, its error and Retry and is not stored; a reload shows the stored truth, and choosing it again saves it', async () => {
		try {
			await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
			const shownBefore = await infoState();
			await A.stop();
			await p.click('#info-table tbody tr:nth-child(3) input[type=checkbox]');
			await errorNames('Invented item C');
			await A.start();
			await p.click('#info-table tbody tr:nth-child(1) input[type=checkbox]');
			const settled = await saved().then(() => true, () => false);
			await sleep(300);
			const mid = { problems: await infoProblems(), marks: await rowMarks(), shown: await infoState(), rows: infoRows() };
			// a reload shows what is stored: A saved, C as stored (its unsaved choice is not shown as saved)
			await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
			const reloaded = { shown: await infoState(), error: await p.evaluate(`!!document.querySelector('#info-error')`) };
			// choosing C again with the server up saves it; a reload shows it
			await p.click('#info-table tbody tr:nth-child(3) input[type=checkbox]');
			await saved().catch(() => {});
			await p.goto(V(vid, 'info_required_tab'), L.ready('info_required_tab'));
			const final = { shown: await infoState(), rows: infoRows() };
			const checks = {
				start: J(shownBefore) === J([[false, false], [true, true], [true, true]]),
				noRowLeftBusy: settled,
				otherSaveSaved: doneOf(mid.rows, 'Invented item A') === true,
				failedKeepsErrorAndRetry: mid.problems.length === 1 && names(mid.problems, 'Invented item C') && /\(not done: Invented item C\)/.test(mid.problems[0].text),
				failedRowMarkedUnsaved: J(mid.marks) === J([null, null, 'unsaved']) && J(mid.shown) === J([[true, true], [true, true], [false, false]]),
				failedNotStored: doneOf(mid.rows, 'Invented item C') === true,
				reloadShowsStored: J(reloaded.shown) === J([[true, true], [true, true], [true, true]]) && !reloaded.error,
				choosingAgainSaves: J(final.shown) === J([[true, true], [true, true], [false, false]]) && doneOf(final.rows, 'Invented item C') === false,
			};
			return { pass: Object.values(checks).every(Boolean), evidence: { checks, shownBefore, mid: { ...mid, rows: mid.rows.length }, reloaded, final: final.shown } };
		} finally { await restarted(); }
	}, { expectsFailures: true });

	await scenario('AN-09', 'witness_tab', 'Scenario 9: a will-say [[REF]] links to its document through Narrative.svelte; a missing ref renders broken; names and bare refs are never turned into links', async () => {
		const nav = await arrive(p, vid, 'witness_tab', name);
		await p.shot(join(SCREENS, 'witness_tab-desktop.png'));
		const rows = await p.evaluate(`[...document.querySelectorAll('#witness-table tbody tr')].map((r) => ({ nameLinks: r.cells[0].querySelectorAll('a').length, links: [...r.cells[2].querySelectorAll('a.cite')].map((a) => a.getAttribute('href').replace(/^.*\\/doc\\//, '')), broken: [...r.cells[2].querySelectorAll('.cite-broken')].map((e) => e.textContent.replace(/[\\[\\]]/g, '').trim()) }))`);
		await p.click('#witness-table a.cite');
		await p.waitFor(`location.pathname.endsWith('/doc/OD-001') && document.querySelector('main#main')?.dataset.ready === 'doc:OD-001'`, 30000);
		const ok = nav.ok && J(rows) === J([{ nameLinks: 0, links: ['OD-001'], broken: ['ZZ-404'] }, { nameLinks: 0, links: [], broken: [] }]);
		return { pass: ok, evidence: { nav, rows } };
	});

	const ANALYSIS = ['matter', 'timeline', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab'];
	await scenario('AN-10', 'all', 'Scenario 10: a package with every optional analysis dataset empty, and one without view-content, render every analysis view with an explicit empty or neutral state and no page error or console error', async () => {
		const ev = {};
		let ok = true;
		const evid = await importActivate(empty);
		const nvid = await importActivate(novc);
		for (const [tag, v] of [['empty', evid], ['no-view-content', nvid]]) {
			for (const view of ANALYSIS) {
				const mk = b.mark();
				await p.goto(V(v, view), L.ready(view));
				await sleep(60);
				const st = await p.evaluate(`({ heading: document.querySelector('h1')?.textContent.trim(), empty: [...document.querySelectorAll('main .an-empty')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()), unavailable: !!document.querySelector('[data-unavailable]') })`);
				const errors = errorsSince(mk);
				const needsEmpty = tag === 'empty';
				const good = st.heading === label(view) && !st.unavailable && errors.length === 0 && (!needsEmpty || st.empty.length > 0);
				ev[`${tag}/${view}`] = { ...st, errors: errors.map((e) => e.text) };
				if (!good) ok = false;
			}
		}
		// without view-content the defence headings are neutral and no case wording stands in
		await p.goto(V(nvid, 'vdm_matrix_tab'), L.ready('vdm_matrix_tab'));
		const heads = await p.evaluate(`[...document.querySelectorAll('#defence-table thead th')].map((t) => t.textContent.trim())`);
		ok = ok && J(heads.slice(0, 5)) === J(['Point', 'Their case', 'Supporting evidence', 'Documents', 'Rebuttal']);
		return { pass: ok, evidence: { views: ev, neutralHeadings: heads } };
	});

	await scenario('AN-NET', 'all', 'no canary hit, no request off the loopback app origin, and no page error, console error or CSP violation outside the failed-write scenarios, during the whole run', async () => {
		const errors = b.events.console.filter((c) => c.at >= t0 && (c.kind === 'exception' || /error/i.test(c.kind)) && !(noisy.some((w) => c.at >= w.from && c.at <= w.to) && /Failed to load resource|net::ERR_/.test(c.text)));
		const reqs = b.events.requests.filter((r) => r.at >= t0).filter((r) => { try { const u = new URL(r.url); return /^(https?|wss?):$/.test(u.protocol) && !['127.0.0.1', 'localhost', 'clearcase-originals.localhost'].includes(u.hostname); } catch { return false; } });
		const hits = canary.hits.filter((h) => h.at >= t0 && !/(^|\.)(google\.com|gvt1\.com|googleapis\.com|gstatic\.com)$/i.test(h.host?.replace(/:\d+$/, '') ?? h.sni ?? ''));
		return { pass: reqs.length === 0 && hits.length === 0 && errors.length === 0, evidence: { offline, offOrigin: reqs.map((r) => r.url.slice(0, 120)), canaryHits: hits.length, errors: errors.map((e) => `${e.kind}: ${e.text.slice(0, 200)}`) } };
	});
} catch (e) {
	scenarios.push({ id: 'HARNESS', view: 'all', pass: false });
	writeFileSync(join(OUT, 'HARNESS.json'), J({ error: String(e?.stack ?? e).slice(0, 4000), offline }, null, 1));
	console.log(`FAIL    HARNESS ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
	await A.stop().catch(() => {});
	await b?.close().catch(() => {});
	await canary?.close().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}
const ok = scenarios.length > 0 && scenarios.every((s) => s.pass);
writeFileSync(join(OUT, 'summary.json'), J({ ok, bun: bunIdentity(), chromium: CHROME, build: existsSync(join(BUILD, 'clearcase-build.json')) ? JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')) : null, scenarios }, null, 1));
console.log(`analysis: ${scenarios.filter((s) => s.pass).length}/${scenarios.length} scenarios PASS -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
