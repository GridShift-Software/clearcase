#!/usr/bin/env bun
// Offline browser suite of the registers (GRS-17, CC-07), run by `bun run --bun test:e2e` in its own network namespace.
// It starts the production entry (bun scripts/pilot/start.ts) on ./build with a fresh data directory, the parity clock
// (CLEARCASE_FIXED_NOW=2026-10-08T09:00:00Z, TZ=UTC), imports and activates a synthetic case built by GRS-10's
// converter (tests/e2e/pilot/lib/fixtures.ts), and drives every register through Chromium: open, add, edit, delete,
// export, the overview tiles, a restart (SIGKILL and graceful) and failed writes caused from outside the app (a busy
// work.sqlite, a stopped server). Synthetic data only. Results: $CLEARCASE_E2E_OUT/registers/<scenario>.json and
// summary.json ({scenarios: [{id, view, pass}]}); synthetic screenshots under registers/screens/. Exit 0 only when every
// scenario passed.
process.env.CANARY_PORT ??= '43199';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { asking, cancelIfAsked, confirmPressed, focusOf, holdEnter, postAction, pressEscape } = await import('../pilot/lib/confirm.mjs');
const { INIT, openPage } = await import('../pilot/suite/browser.mjs');
const { appServer, vpath } = await import('../pilot/suite/context.mjs');
const { startServer } = await import('../pilot/lib/server.mjs');
const { buildCase } = await import('../pilot/lib/fixtures.ts');
const { SYNTH_VIEW_CODE } = await import('../../case-package/fixtures/synth.ts');
const { parseCsv, parseIcs } = await import('../../../scripts/parity/lib/exports.mjs');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');
const { EXPORT_NAME_NOTE } = await import('../../../src/lib/local-case/results.server.ts');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = join(ROOT, 'build');
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'registers');
const SCREENS = join(OUT, 'screens');
mkdirSync(SCREENS, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
const J = JSON.stringify;
const REGISTER_VIEWS = ['disbursements_tab', 'timesheet_tab', 'deadlines_tab', 'privilege_tab', 'popia_tab', 'annotations_tab', 'transcriptions_tab'];
const LABEL = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));
const EMPTY = { disbursements_tab: 'No disbursements recorded.', timesheet_tab: 'No time recorded.', deadlines_tab: 'No deadlines yet.', privilege_tab: 'No privilege entries.', popia_tab: 'No POPIA records.', annotations_tab: 'No annotations yet.', transcriptions_tab: 'No transcripts stored.' };
const STORE = { disbursements_tab: 'disbursements', timesheet_tab: 'timesheet', deadlines_tab: 'deadlines', privilege_tab: 'privilege', popia_tab: 'popia', annotations_tab: 'annotations', transcriptions_tab: 'transcripts' };
const AUTOMATED = 'no-reply@synthetic.invalid';

const results = [];
/** One scenario: its checks (all must hold) and evidence, written to registers/<id>.json. */
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

// ---- page helpers --------------------------------------------------------------------------------------------------

/** Downloads made through an <a download> blob link are kept as text in window.__downloads (test instrumentation). */
const HOOK = `(() => { window.__downloads = []; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { o.text().then((t) => window.__downloads.push({ name: this.download, type: o.type, text: t })); return; } return click.call(this); };
})();`;

let p, A, rv, titleName, tmp, b;
const base = () => `${A.origin}${vpath(rv)}`;
const ready = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)}`;
const rows = () => p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id]')].map((r) => ({ id: r.dataset.rowId, cells: [...r.cells].slice(0, -1).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), link: r.cells[0]?.querySelector('a')?.getAttribute('href') ?? null, broken: !!r.cells[0]?.querySelector('.cite-broken') }))`);
const emptyRow = () => p.evaluate(`document.querySelector('#register-table tbody tr:not([data-row-id])')?.textContent.trim() ?? null`);
const fieldValues = () => p.evaluate(`Object.fromEntries([...document.querySelectorAll('#register-form [name]')].map((e) => [e.name, e.value]))`);
const errorText = () => p.evaluate(`document.getElementById('register-error')?.textContent.trim() ?? null`);
const openView = async (view) => { await p.goto(`${base()}/registers/${view}`, `${ready(view)} && !!document.querySelector('main#main[data-hydrated]')`); };
const screenshot = async (name) => { const r = await p.s('Page.captureScreenshot', { format: 'png' }); const f = join(SCREENS, `${name}.png`); writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };

/** Fill fields by v5 key: text inputs and textareas are typed, dates and selects are set as a user agent does. */
async function fill(entry) {
	for (const [k, v] of Object.entries(entry)) {
		const kind = await p.evaluate(`(() => { const e = document.getElementById('in-${k}'); return e ? (e.tagName === 'SELECT' ? 'select' : e.type) : null; })()`);
		if (!kind) throw new Error(`no field ${k}`);
		if ((kind === 'text' || kind === 'textarea') && v !== '') await p.type(`#in-${k}`, v);
		else await p.evaluate(`(() => { const e = document.getElementById('in-${k}'); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
	}
}
const count = () => p.evaluate(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length`);
/** Press Add (or Save while editing) and wait until the save finished: `n` rows, not editing, not busy, or an error. */
async function save(n) {
	await p.click('#register-save');
	await p.waitFor(`(document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n} && !document.querySelector('#register-form[data-editing]') && !document.querySelector('#register-save[disabled]')) || !!document.getElementById('register-error')`, 30000);
	await sleep(50);
}
async function add(entry) { const n = await count(); await fill(entry); await save(n + 1); return rows(); }
/** Press a row's Delete, then its Confirm delete. */
async function pressDelete(rowId) { const row = `#register-table tr[data-row-id="${rowId}"]`; await p.click(`${row} [data-delete]`); await confirmPressed(p, row); }
async function del(rowId) { const n = await count(); await pressDelete(rowId); await p.waitFor(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n - 1} || !!document.getElementById('register-error')`, 30000); }
async function exportNow() {
	await p.evaluate('window.__downloads.length = 0');
	await p.click('#register-export');
	await p.waitFor('window.__downloads.length > 0', 5000);
	return p.evaluate('window.__downloads[0]');
}
/** The store's rows read from work.sqlite (read-only; the server keeps running). */
const stored = (store) => A.work('SELECT row_id, fields, anchor FROM register_row WHERE store = ? ORDER BY row_id', store).map((r) => ({ id: r.row_id, fields: JSON.parse(r.fields), anchor: r.anchor ? JSON.parse(r.anchor) : null }));
const tiles = async () => {
	await p.goto(`${base()}/overview`, ready('overview'));
	return p.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-slot]')].map((s) => [s.dataset.slot, { status: s.dataset.slotStatus, value: s.querySelector('.num')?.textContent.trim() ?? null, sub: s.querySelector('p:not(.num)')?.textContent.trim() ?? null }]))`);
};
async function clearView(view) { await openView(view); for (const r of await rows()) await del(r.id); return count(); }

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
writeFileSync(join(OUT, 'offline.json'), J(offline, null, 1));
if (!offline.pass) { console.error('registers suite: not offline'); writeFileSync(join(OUT, 'summary.json'), J({ ok: false, offline: false, scenarios: [] })); process.exit(1); }
tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-registers-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
let ok = false;
try {
	A = appServer({ name: 'registers', root: ROOT, buildDir: BUILD, port: 43100, origPort: 43101, dir: tmp });
	// the pilot's restartable server, started with the parity clock and timezone
	A.start = async () => {
		A.srv = await startServer({ root: ROOT, port: A.port, origPort: A.origPort, dataDir: A.dataDir, buildDir: BUILD, logFile: A.logFile, env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
		A.starts.push({ pid: A.srv.pid, readyMs: Math.round(A.srv.readyMs) });
		return A.srv;
	};
	await A.start();
	// the calendar's case part gets a ';' and a ',' so SC18 covers its TEXT escaping
	const viewCode = SYNTH_VIEW_CODE.replace(/PRODID:-\/\/([^/]+)\/\//, 'PRODID:-//$1; synthetic, part//');
	const sc = await buildCase(join(tmp, 'case'), { caseId: 'e2e-registers', viewCode, edit: (r) => { r.DATA.chronology.find((x) => x.ref === 'OD-002').sender = AUTOMATED; } });
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	const act = await A.c.activate(imp.importId);
	rv = await A.c.activeVersion();
	if (rv !== sc.resultsVersion) throw new Error(`activation failed: ${J({ imp: { status: imp.status, id: imp.importId }, act })}`);
	const manifest = JSON.parse(new TextDecoder().decode(sc.files.get('manifest.json')));
	const vc = sc.files.get('datasets/view-content.json');
	const shellTitle = vc ? JSON.parse(new TextDecoder().decode(vc)).data?._shell?.documentTitle : null;
	/** the calendar's file name from the built synthetic package's view-content (never a literal) */
	const icsName = vc ? JSON.parse(new TextDecoder().decode(vc)).data?.deadlines_tab?.exportFileName ?? null : null;
	titleName = typeof shellTitle === 'string' && shellTitle.trim() ? shellTitle : manifest.case.label || manifest.case.id;
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: `${INIT};${HOOK}` });

	// 1. Each register's first state, reached from the overview's navigation: title, focused heading, empty state.
	for (const view of REGISTER_VIEWS) {
		await scenario(`SC1-${view}`, view, 'opened from the navigation: document title, heading focused, v5 empty state, Add and export controls, no unavailable state', async () => {
			await p.goto(`${base()}/overview`, ready('overview'));
			await p.click(`#nav-${view}`);
			await p.waitFor(`${ready(view)} && document.activeElement?.hasAttribute('data-page-heading')`, 15000);
			const s = await p.evaluate(`({ title: document.title, h1: document.querySelector('[data-page-heading]').textContent.trim(), focused: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null, unavailable: !!document.querySelector('[data-unavailable]'), add: document.getElementById('register-save')?.textContent.trim(), exp: document.getElementById('register-export')?.textContent.trim() })`);
			const empty = await emptyRow();
			return { evidence: { ...s, empty }, checks: { title: s.title === `${LABEL[view]} · ${titleName} · ClearCase`, heading: s.h1 === LABEL[view], focus: s.focused, current: s.current === `nav-${view}`, available: !s.unavailable, empty: empty === EMPTY[view], add: s.add === 'Add', export: s.exp === (view === 'deadlines_tab' ? 'Export .ics' : 'Export CSV') } };
		});
	}

	// 2. Create and edit a disbursement.
	await scenario('SC2', 'disbursements_tab', 'create a disbursement, edit it in place through the same form: one row, same id, new values; money shown as v5 formats it', async () => {
		await openView('disbursements_tab');
		await add({ date: '2026-10-01', desc: 'Synthetic courier', payee: 'Synthetic Couriers', amount: '1500' });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await p.waitFor(`document.getElementById('register-save').textContent.trim() === 'Save' && document.activeElement?.id === 'in-date'`, 5000);
		const editing = await fieldValues();
		await fill({ amount: '1750.5', desc: 'Synthetic courier, edited' });
		const shot = await screenshot('sc2-disbursement-edit');
		await save(1);
		const after = await rows();
		const db = stored('disbursements');
		await p.goto(`${base()}/registers/disbursements_tab`, ready('disbursements_tab'));
		const reloaded = await rows();
		return { evidence: { editing, after, db, shot },
			checks: { formLoaded: editing.amount === '1500' && editing.rowId === r1.id, oneRow: after.length === 1 && db.length === 1, sameId: after[0]?.id === r1.id && db[0]?.id === r1.id,
				cells: J(after[0]?.cells) === J(['2026-10-01', 'Synthetic courier, edited', 'Synthetic Couriers', 'R 1 750.50']), reload: J(reloaded) === J(after), addAgain: (await p.evaluate(`document.getElementById('register-save').textContent.trim()`)) === 'Add' } };
	});

	// 3. Record time and verify its value (and the corrected unbilled figure, S-overview-1).
	await scenario('SC3', 'timesheet_tab', "record time: Value = money(hours × rate); the overview's Unbilled time counts 'no' and blank, not 'yes' (S-overview-1)", async () => {
		await openView('timesheet_tab');
		await add({ date: '2026-10-05', fee_earner: 'Synthetic earner', activity: 'Synthetic drafting', hours: '2.5', rate: '1200', billed: 'no' });
		await add({ date: '2026-10-06', fee_earner: 'Synthetic earner', activity: 'Synthetic call', hours: '1', rate: '', billed: '' });
		await add({ date: '2026-10-07', fee_earner: 'Synthetic earner', activity: 'Synthetic billed', hours: '4', rate: '1000', billed: 'yes' });
		const r = await rows();
		const t = await tiles();
		return { evidence: { rows: r, tiles: t },
			checks: { value: r[0]?.cells[6] === 'R 3 000.00', zero: r[1]?.cells[6] === 'R 0.00', billed: r[2]?.cells[5] === 'yes' && r[2]?.cells[6] === 'R 4 000.00', unbilled: t['unbilled-time']?.status === 'filled' && t['unbilled-time']?.value === '3.5 h' && t['unbilled-time']?.sub === 'recorded, not yet billed' } };
	});

	// 4. Create deadlines and export the calendar; the countdown at the fixed clock; Delete on the shown row.
	await scenario('SC4', 'deadlines_tab', 'deadlines at the fixed clock (deadline-countdown-fixed-clock), Delete removes the shown row (deadline-delete-shown-row, S-deadlines_tab-1), RFC 5545 calendar export, Open deadlines tile', async () => {
		await openView('deadlines_tab');
		for (const [t, d] of [['E', '2026-10-16'], ['A', '2026-10-01'], ['C', '2026-10-08'], ['D', '2026-10-15'], ['B', '2026-10-07']]) await add({ title: `Synthetic ${t}`, date: d, note: '' });
		const shown = (await rows()).map((r) => [r.cells[2], r.cells[1]]);
		const tones = await p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id] td:nth-child(2) .chip')].map((c) => c.className.match(/tone-(\\w+)/)?.[1])`);
		const t = await tiles();
		await clearView('deadlines_tab');
		// expected example deadline-delete-shown-row: stored [later, earlier]; Delete on the first shown row (earlier)
		await add({ title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' });
		await add({ title: 'Synthetic earlier', date: '2026-11-01', cat: 'Hearing', note: '' });
		const firstShown = (await rows())[0];
		await del(firstShown.id);
		const left = stored('deadlines').map((r) => ({ title: r.fields.title, date: r.fields.date, cat: r.fields.cat, note: r.fields.note }));
		await add({ title: 'Synthetic hearing, room 2; floor 1', date: '2026-11-20', cat: 'Hearing', note: 'bring\\files' });
		const ics = await exportNow();
		const parsed = parseIcs(ics.text);
		const ids = (await rows()).map((r) => r.id);
		const shot = await screenshot('sc4-deadlines');
		return { evidence: { shown, tones, tiles: t, firstShown: firstShown.cells, left, ics: { name: ics.name, type: ics.type, parsed }, shot },
			checks: {
				order: J(shown) === J([['Synthetic A', '7d ago'], ['Synthetic B', '1d ago'], ['Synthetic C', 'today'], ['Synthetic D', 'in 7d'], ['Synthetic E', 'in 8d']]),
				tones: J(tones) === J(['muted', 'muted', 'danger', 'warning', 'success']),
				openTile: t.deadlines?.status === 'filled' && t.deadlines?.value === '3' && t.deadlines?.sub === 'in the deadline tracker',
				deletedShown: firstShown.cells[2] === 'Synthetic earlier' && J(left) === J([{ title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' }]),
				crlf: ics.text.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics.text) && typeof icsName === 'string' && icsName !== 'deadlines.ics' && ics.name === icsName && /text\/calendar/.test(ics.type),
				events: parsed.rows.length === 2 && parsed.columns.join(',') === 'DESCRIPTION,DTSTAMP,DTSTART,SUMMARY,UID',
				uids: J(parsed.rows.map((r) => r[4]).sort()) === J(ids.map((id) => `${id}@clearcase`).sort()),
				fields: parsed.rows.some((r) => r[3] === 'Synthetic hearing\\, room 2\\; floor 1' && r[0] === 'Hearing bring\\\\files' && r[2] === '20261120T090000' && r[1] === '20261008T090000Z'),
			} };
	});
	await clearView('deadlines_tab');
	await clearView('timesheet_tab');

	// 5. Edit privilege and POPIA records; a Doc ref naming a document links to it, one naming nothing renders broken.
	await scenario('SC5-privilege', 'privilege_tab', 'privilege entry added and edited in place; a ref naming an imported document links to its page and keeps an anchor; a missing ref renders broken, never matched loosely (S-privilege_tab-1)', async () => {
		await openView('privilege_tab');
		await add({ ref: 'OD-001', date: '2026-10-01', desc: 'Synthetic withheld agreement', basis: 'Legal advice' });
		await add({ ref: 'OD-01', date: '', desc: 'Synthetic near miss', basis: 'Other' });
		const [r1, r2] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await fill({ basis: 'Litigation', desc: 'Synthetic withheld agreement, edited' });
		await save(2);
		const after = await rows();
		const db = stored('privilege');
		return { evidence: { after, db: db.map((r) => ({ id: r.id, ref: r.fields.ref, anchored: !!r.anchor })) },
			checks: { edited: J(after[0].cells) === J(['OD-001', '2026-10-01', 'Synthetic withheld agreement, edited', 'Litigation']) && after[0].id === r1.id,
				link: after[0].link === `${vpath(rv)}/doc/OD-001`, missing: after[1].link === null && after[1].broken && after[1].cells[0] === 'OD-01' && r2.id === after[1].id,
				anchor: db.find((r) => r.id === r1.id)?.anchor?.refAtCreation === 'OD-001' && db.find((r) => r.id === r2.id)?.anchor === null, typedKept: db.find((r) => r.id === r2.id)?.fields.ref === 'OD-01' } };
	});
	await scenario('SC5-popia', 'popia_tab', 'POPIA record added (one field is enough, v5) and edited in place', async () => {
		await openView('popia_tab');
		await add({ retention: 'Synthetic 5 years' });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await fill({ activity: 'Synthetic correspondence review', lawful: 'Synthetic legitimate interest' });
		await save(1);
		const after = await rows();
		return { evidence: { after }, checks: { saved: J(r1.cells) === J(['', '', '', 'Synthetic 5 years']), edited: J(after[0].cells) === J(['Synthetic correspondence review', '', 'Synthetic legitimate interest', 'Synthetic 5 years']) && after[0].id === r1.id } };
	});

	// 6. Add a document annotation and follow its ref to the document.
	await scenario('SC6', 'annotations_tab', 'annotation on a document: the ref links to the document page, the multi-line note is kept as typed; a missing ref renders broken (S-annotations_tab-1)', async () => {
		await openView('annotations_tab');
		await add({ ref: 'SD-001', date: '2026-10-02', note: 'Synthetic first line\nSynthetic second line' });
		await add({ ref: 'ZZ-404', date: '', note: 'Synthetic note on nothing' });
		const r = await rows();
		const db = stored('annotations');
		await p.click(`#register-table tr[data-row-id="${r[0].id}"] a`);
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === 'doc:SD-001'`, 15000);
		const doc = await p.evaluate(`({ path: location.pathname, h1: document.querySelector('[data-page-heading]')?.textContent.trim() })`);
		return { evidence: { rows: r, doc },
			checks: { link: r[0].link === `${vpath(rv)}/doc/SD-001` && doc.path === `${vpath(rv)}/doc/SD-001`, note: db.find((x) => x.id === r[0].id)?.fields.note === 'Synthetic first line\nSynthetic second line', broken: r[1].broken && r[1].link === null } };
	});

	// 7. Inspect and edit a transcript.
	await scenario('SC7', 'transcriptions_tab', 'transcript stored with its full text, shown whole, and its title edited in place', async () => {
		await openView('transcriptions_tab');
		const body = Array.from({ length: 40 }, (_, i) => `Synthetic line ${i + 1}: speaker says something.`).join('\n');
		await add({ title: 'Synthetic hearing', date: '2026-09-30', source: 'Synthetic recording', body });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		const loaded = (await fieldValues()).body;
		await fill({ title: 'Synthetic hearing (day 1)' });
		await save(1);
		const after = await rows();
		const db = stored('transcripts');
		return { evidence: { cells: after[0].cells.map((c) => c.slice(0, 60)) }, checks: { whole: after[0].cells[3] === body.replace(/\s+/g, ' '), loaded: loaded === body, edited: after[0].cells[0] === 'Synthetic hearing (day 1)' && db[0].fields.body === body && db.length === 1 } };
	});

	// 8. Delete a controlled test record (the privilege ledger example), and the CSV export (S-csv).
	await scenario('SC8', 'privilege_tab', 'ledger-privilege-add-add-delete through the UI (an all-empty Add saves nothing); Delete removes exactly the chosen row; CSV keeps v5 columns, neutralises formulas and quotes commas and quotes', async () => {
		await clearView('privilege_tab');
		await add({ ref: 'OD-002', date: '2026-10-01', desc: 'Synthetic entry one', basis: 'Legal advice' });
		await p.click('#register-save'); await sleep(400);
		const afterEmpty = await count();
		await add({ ref: 'SD-010', date: '', desc: 'Synthetic entry two', basis: 'Litigation' });
		await del((await rows())[0].id);
		const left = stored('privilege').map((r) => ({ ref: r.fields.ref, date: r.fields.date, desc: r.fields.desc, basis: r.fields.basis }));
		// a browser turns a typed CR into a space, so a bare CR cannot come from the form; the CSV unit test covers it
		await add({ ref: '=HYPERLINK("x")', date: '', desc: 'Synthetic, "quoted"', basis: '' });
		const csv = await exportNow();
		const parsed = parseCsv(csv.text);
		return { evidence: { afterEmpty, left, csv: { name: csv.name, rows: parsed } },
			checks: { emptyIgnored: afterEmpty === 1, example: J(left) === '[{"ref":"SD-010","date":"","desc":"Synthetic entry two","basis":"Litigation"}]',
				csvHeader: J(parsed[0]) === J(['ref', 'date', 'desc', 'basis']) && csv.name === 'privilege.csv', csvRows: J(parsed.slice(1)) === J([['SD-010', '', 'Synthetic entry two', 'Litigation'], ["'=HYPERLINK(\"x\")", '', 'Synthetic, "quoted"', '']]),
				quoted: csv.text.includes('"\'=HYPERLINK(""x"")"') && csv.text.includes('"Synthetic, ""quoted"""') } };
	});

	// BA-07: an automated sender is never turned into a role or a privilege finding.
	await scenario('BA-07', 'privilege_tab', 'privilege entry on a document from an automated sender: the sender is shown exactly as imported, no role, attorney or privilege status is derived, the only basis is the one the user chose', async () => {
		await clearView('privilege_tab');
		await add({ ref: 'OD-002', date: '2026-10-03', desc: 'Synthetic automated notice', basis: 'Without prejudice' });
		const r = await rows();
		const page = await p.evaluate(`document.querySelector('#register-table').innerText + '\\n' + document.querySelector('.page-head').innerText`);
		const shot = await screenshot('ba07-privilege-automated-sender');
		await p.click(`#register-table tr[data-row-id="${r[0].id}"] a`);
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === 'doc:OD-002'`, 15000);
		const doc = await p.evaluate(`({ text: document.querySelector('main').innerText, from: [...document.querySelectorAll('main dt, main th')].find((e) => e.textContent.trim() === 'From')?.nextElementSibling?.textContent.trim() ?? null })`);
		const shotDoc = await screenshot('ba07-document-automated-sender');
		const words = /attorney|lawyer|advocate|counsel for|privileged|privilege status|verified role/i;
		return { evidence: { row: r[0].cells, from: doc.from, shots: [shot, shotDoc] },
			checks: { basis: r[0].cells[3] === 'Without prejudice', onlyBasis: r.length === 1 && J(r[0].cells) === J(['OD-002', '2026-10-03', 'Synthetic automated notice', 'Without prejudice']), senderExact: doc.from === AUTOMATED, noRolePage: !words.test(page), noRoleDoc: !words.test(doc.text) } };
	});

	// 10. Failed writes, caused from outside the app: a busy work.sqlite, then a stopped server.
	await scenario('SC10-busy', 'disbursements_tab', 'a save while work.sqlite is held busy (BEGIN IMMEDIATE, 13 s): the error is shown, every typed value is kept, nothing is written; after release one retry saves exactly one row', async () => {
		await clearView('disbursements_tab');
		const entry = { date: '2026-10-04', desc: 'Synthetic busy save', payee: 'Synthetic payee', amount: '99.95' };
		await fill(entry);
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
		const t0 = Date.now();
		let during;
		try {
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-error')`, 30000);
			during = { error: await errorText(), values: await fieldValues(), rows: await count(), ms: Date.now() - t0 };
			while (Date.now() - t0 < 13000) await sleep(100);
		} finally { lock.exec('ROLLBACK'); lock.close(); }
		const dbDuring = stored('disbursements').length;
		await save(1);
		const after = { rows: await rows(), error: await errorText(), db: stored('disbursements') };
		return { evidence: { during, after: { rows: after.rows, error: after.error } },
			checks: { errorShown: /not saved/.test(during.error ?? ''), kept: J({ date: during.values.date, desc: during.values.desc, payee: during.values.payee, amount: during.values.amount }) === J(entry), nothingWritten: during.rows === 0 && dbDuring === 0, retryOnce: after.db.length === 1 && after.rows.length === 1 && after.error === null && after.db[0].fields.desc === entry.desc } };
	});
	await scenario('SC10-transport', 'timesheet_tab', 'a save while the server is stopped: the error is shown, every typed value is kept, nothing is written; after a restart one retry saves exactly one row', async () => {
		await clearView('timesheet_tab');
		const entry = { date: '2026-10-04', fee_earner: 'Synthetic earner', activity: 'Synthetic offline save', hours: '1.5', rate: '900', billed: 'no' };
		await fill(entry);
		await A.stop();
		await p.click('#register-save');
		await p.waitFor(`!!document.getElementById('register-error')`, 30000);
		const during = { error: await errorText(), values: await fieldValues(), rows: await count() };
		await A.start();
		const dbDuring = stored('timesheet').length;
		await save(1);
		const after = { rows: await rows(), error: await errorText(), db: stored('timesheet') };
		const { rowId: _r, ...typed } = during.values;
		return { evidence: { during, after: { rows: after.rows, error: after.error } },
			checks: { errorShown: /could not be reached/.test(during.error ?? ''), kept: J(typed) === J(entry), nothingWritten: during.rows === 0 && dbDuring === 0, retryOnce: after.db.length === 1 && after.rows.length === 1 && after.error === null } };
	});

	// 9. Restart (SIGKILL, then graceful) and recover every saved entry, by id and fields, in every register.
	{
		await openView('deadlines_tab');
		await add({ title: 'Synthetic restart deadline', date: '2026-10-20', cat: 'Payment', note: 'kept' });
		await openView('transcriptions_tab');
		await add({ title: 'Synthetic second transcript', date: '', source: '', body: 'x' });
		const snapshot = () => Object.fromEntries(REGISTER_VIEWS.map((v) => [v, stored(STORE[v]).map((r) => J(r))]));
		const shown = async () => { const out = {}; for (const v of REGISTER_VIEWS) { await openView(v); out[v] = (await rows()).map((r) => [r.id, r.cells]); } return out; };
		const before = snapshot();
		const shownBefore = await shown();
		const killed = await A.srv.stop('SIGKILL');
		await A.start();
		const afterKill = snapshot();
		const shownKill = await shown();
		const graceful = await A.stop();
		await A.start();
		const afterGraceful = snapshot();
		const shownGraceful = await shown();
		for (const view of REGISTER_VIEWS) {
			await scenario(`SC9-${view}`, view, 'every saved entry recovered after a SIGKILL restart and after a graceful restart, by row id and fields, in the store and on the page', async () => ({
				evidence: { rows: before[view].length, killed: { graceful: killed.graceful }, gracefulStop: graceful.graceful },
				checks: { nonEmpty: before[view].length > 0, kill: J(afterKill[view]) === J(before[view]), gracefulRestart: J(afterGraceful[view]) === J(before[view]) && graceful.graceful === true,
					pageKill: J(shownKill[view]) === J(shownBefore[view]), pageGraceful: J(shownGraceful[view]) === J(shownBefore[view]) },
			}));
		}
	}

	// 11-18. CC-07 r2: unsaved input is never lost or shown as saved (D1-D5), more edits and exports (D13-D15, D18).
	// The busy store is caused from outside the app, as in SC10-busy: work.sqlite held with BEGIN IMMEDIATE.
	const hold = () => { const l = new Database(join(A.dataDir, 'work.sqlite')); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); let held = true; return () => { if (held) { held = false; l.exec('ROLLBACK'); l.close(); } }; };
	const formState = () => p.evaluate(`({ save: document.getElementById('register-save')?.textContent.trim() ?? null, editing: document.querySelector('#register-form')?.dataset.editing ?? null, rowId: document.querySelector('#register-form input[name=rowId]')?.value ?? null,
		fieldsDisabled: !!document.querySelector('#register-form fieldset')?.disabled, editDisabled: [...document.querySelectorAll('[data-edit]')].map((b) => b.disabled), deleteDisabled: [...document.querySelectorAll('[data-delete]')].map((b) => b.disabled),
		cancelDisabled: document.getElementById('register-cancel')?.disabled ?? null, status: document.getElementById('register-status')?.textContent.trim() ?? null, error: document.querySelector('#register-error p')?.textContent.trim() ?? null,
		retry: !!document.getElementById('register-retry'), deleteError: document.querySelector('#register-delete-error p')?.textContent.trim() ?? null, ask: document.getElementById('register-ask-text')?.textContent.trim() ?? null })`);
	const dbField = (store, id, k) => stored(store).find((r) => r.id === id)?.fields[k] ?? null;
	const editRow = async (id) => { await p.click(`#register-table tr[data-row-id="${id}"] [data-edit]`); await p.waitFor(`document.querySelector('#register-form')?.dataset.editing === ${J(id)}`, 5000); };
	const idle = () => p.waitFor(`!document.getElementById('register-status')`, 30000);
	const failSave = async () => { const release = hold(); try { await p.click('#register-save'); await p.waitFor(`!!document.getElementById('register-error')`, 30000); } finally { release(); } };
	const descs = async () => (await rows()).map((r) => r.cells[1]);

	await scenario('SC11-nojs', 'disbursements_tab', 'without JavaScript: Add then Add keeps both rows in order (a success never re-enters edit mode); a refused save re-renders with its message and every typed value; a deadline without a date says why (D1, D13)', async () => {
		await clearView('disbursements_tab');
		await p.s('Emulation.setScriptExecutionDisabled', { value: true });
		try {
			const at = async (view) => { await p.navigate(`${base()}/registers/${view}`); await p.waitFor(ready(view), 20000); };
			const setVals = (o) => p.evaluate(`(() => { for (const [k, v] of Object.entries(${J(o)})) document.getElementById('in-' + k).value = v; return true; })()`);
			const submit = async (view) => { await p.evaluate('window.__nojs = 1'); await p.click('#register-save'); await p.waitFor(`window.__nojs !== 1 && ${ready(view)}`, 20000); };
			await at('disbursements_tab');
			const hydrated = await p.evaluate(`!!document.querySelector('main#main[data-hydrated]')`);
			await setVals({ date: '2026-10-02', desc: 'Synthetic no-JS first', payee: 'Synthetic payee', amount: '10' });
			await submit('disbursements_tab');
			const afterFirst = await formState();
			await setVals({ desc: 'Synthetic no-JS second', amount: '20' });
			await submit('disbursements_tab');
			const afterSecond = { form: await formState(), rows: await descs() };
			await setVals({ desc: 'Synthetic no-JS refused', amount: '1 500,50' });
			await submit('disbursements_tab');
			const refused = { form: await formState(), values: await fieldValues() };
			const db = stored('disbursements').map((r) => r.fields.desc).sort();
			// a refused Add on a busy store, then Delete of another row: the refusal, its Retry and the typed values stay
			// (the Delete is off, with a note) until Retry saves the entry
			await setVals({ desc: 'Synthetic no-JS busy', amount: '30' });
			const release = hold();
			try { await submit('disbursements_tab'); } finally { release(); }
			const busy = { form: await formState(), note: await p.evaluate(`document.getElementById('register-nojs-note')?.textContent.trim() ?? null`) };
			await p.evaluate('window.__nojs = 1');
			await p.click('#register-table tbody tr[data-row-id] [data-delete]');
			await sleep(1500);
			if (await p.evaluate('window.__nojs !== 1')) await p.waitFor(ready('disbursements_tab'), 20000);
			const afterDelete = { form: await formState(), values: await fieldValues(), db: stored('disbursements').length };
			if (afterDelete.form.retry) { await p.evaluate('window.__nojs = 1'); await p.click('#register-retry'); await p.waitFor(`window.__nojs !== 1 && ${ready('disbursements_tab')}`, 20000); }
			const retried = { form: await formState(), db: stored('disbursements').map((r) => r.fields.desc).sort() };
			await at('deadlines_tab');
			await setVals({ title: 'Synthetic no-JS deadline', date: '' });
			await submit('deadlines_tab');
			const deadline = { form: await formState(), values: await fieldValues(), db: stored('deadlines').filter((r) => r.fields.title === 'Synthetic no-JS deadline').length };
			return { evidence: { hydrated, afterFirst, afterSecond, refused, db, busy, afterDelete, retried, deadline },
				checks: { noScripts: !hydrated, addMode: afterFirst.save === 'Add' && afterFirst.rowId === null && afterFirst.editing === null, bothRows: J(afterSecond.rows) === J(['Synthetic no-JS first', 'Synthetic no-JS second']) && afterSecond.form.save === 'Add',
					refusedKept: /decimal comma/.test(refused.form.error ?? '') && refused.values.amount === '1 500,50' && refused.values.desc === 'Synthetic no-JS refused' && refused.form.save === 'Add', dbTwo: J(db) === J(['Synthetic no-JS first', 'Synthetic no-JS second']),
					busyRefused: /not saved/.test(busy.form.error ?? '') && busy.form.retry && busy.form.deleteDisabled.every(Boolean) && /Retry or discard/.test(busy.note ?? ''),
					keptAfterDelete: /not saved/.test(afterDelete.form.error ?? '') && afterDelete.form.retry && afterDelete.values.desc === 'Synthetic no-JS busy' && afterDelete.values.amount === '30' && afterDelete.db === 2,
					retrySaved: retried.form.error === null && J(retried.db) === J(['Synthetic no-JS busy', 'Synthetic no-JS first', 'Synthetic no-JS second']),
					deadlineWhy: /^Title and Date must be filled in/.test(deadline.form.error ?? '') && deadline.values.title === 'Synthetic no-JS deadline' && deadline.db === 0 } };
		} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
	});

	await scenario('SC12-inflight-edit', 'disbursements_tab', "a save in flight on a busy store makes the form, Cancel and every row's Edit and Delete inert and says so; Edit on another row then does nothing; the failure keeps row 1's typed edit in edit mode with Retry, and Retry saves it (D2)", async () => {
		await clearView('disbursements_tab');
		for (const n of [1, 2, 3]) await add({ date: `2026-10-0${n}`, desc: `Synthetic row ${n}`, payee: 'Synthetic payee', amount: `${n}0` });
		const [r1, , r3] = await rows();
		await editRow(r1.id);
		await fill({ desc: 'Synthetic row 1 TYPED' });
		const release = hold();
		let during, afterEdit3, failed;
		try {
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-status')`, 5000);
			during = await formState();
			await p.click(`#register-table tr[data-row-id="${r3.id}"] [data-edit]`);
			await sleep(200);
			afterEdit3 = await formState();
			await p.waitFor(`!!document.getElementById('register-error')`, 30000);
			failed = { ...(await formState()), values: await fieldValues() };
		} finally { release(); }
		const dbFailed = dbField('disbursements', r1.id, 'desc');
		await p.click('#register-retry');
		await p.waitFor(`!document.getElementById('register-error') && !document.querySelector('#register-form[data-editing]') && !document.getElementById('register-status')`, 30000);
		const after = { form: await formState(), db: dbField('disbursements', r1.id, 'desc'), rows: await descs() };
		return { evidence: { during, afterEdit3, failed, after },
			checks: { inert: during.fieldsDisabled && during.editDisabled.every(Boolean) && during.deleteDisabled.every(Boolean) && during.cancelDisabled === true, busyShown: /Saving/.test(during.status ?? ''), editIgnored: afterEdit3.editing === r1.id && !afterEdit3.ask,
				failureKept: failed.editing === r1.id && failed.values.rowId === r1.id && failed.values.desc === 'Synthetic row 1 TYPED' && /not saved/.test(failed.error ?? '') && failed.retry, nothingWritten: dbFailed === 'Synthetic row 1',
				retrySaved: after.db === 'Synthetic row 1 TYPED' && after.form.error === null && J(after.rows) === J(['Synthetic row 1 TYPED', 'Synthetic row 2', 'Synthetic row 3']) } };
	});

	await scenario('SC13-inflight-success', 'disbursements_tab', 'a save that succeeds after the store was busy for 1.5 s: nothing can be typed while it is in flight, the row holds what was submitted, then the form clears; an Add in flight likewise (D3)', async () => {
		const [, r2] = await rows();
		await editRow(r2.id);
		await fill({ desc: 'Synthetic row 2 CORRECTED' });
		let release = hold();
		let during, typedDuring, addDuring, addTyped;
		try {
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-status')`, 5000);
			during = await formState();
			await p.type('#in-amount', '999');
			typedDuring = await fieldValues();
			await sleep(1500);
		} finally { release(); }
		await idle();
		await p.waitFor(`!document.querySelector('#register-form[data-editing]')`, 30000);
		const after = { form: await formState(), values: await fieldValues(), db: stored('disbursements').find((r) => r.id === r2.id)?.fields ?? null };
		await fill({ date: '2026-10-09', desc: 'Synthetic add in flight', amount: '5' });
		release = hold();
		try {
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-status')`, 5000);
			addDuring = await formState();
			await p.type('#in-payee', 'Synthetic typed in flight');
			addTyped = await fieldValues();
			await sleep(1500);
		} finally { release(); }
		await idle();
		await p.waitFor(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length === 4`, 30000);
		const added = stored('disbursements').find((r) => r.fields.desc === 'Synthetic add in flight')?.fields ?? null;
		const afterAdd = { form: await formState(), values: await fieldValues() };
		return { evidence: { during, typedDuring, after, addDuring, addTyped, added, afterAdd },
			checks: { inert: during.fieldsDisabled && during.editDisabled.every(Boolean), notTypable: typedDuring.amount === '20' && typedDuring.desc === 'Synthetic row 2 CORRECTED', saved: after.db?.desc === 'Synthetic row 2 CORRECTED' && after.db?.amount === '20',
				cleared: after.form.editing === null && after.form.error === null && after.values.desc === '', addInert: addDuring.fieldsDisabled && addTyped.payee === '', addSaved: added?.payee === '' && added?.amount === '5' && afterAdd.form.error === null && afterAdd.values.desc === '' } };
	});

	await scenario('SC14-delete-errors', 'disbursements_tab', "a failed save stays visible with its unsaved edit when another row's Delete succeeds; a failed delete is shown apart and clears neither; Retry then saves the edit and leaves the delete error (D4)", async () => {
		const [r1, r2, r3] = await rows();
		const delOk = async (id) => { const n = await count(); await pressDelete(id); await p.waitFor(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n - 1} || !!document.getElementById('register-delete-error')`, 30000); await sleep(50); };
		await editRow(r1.id);
		await fill({ desc: 'Synthetic row 1 UNSAVED' });
		await failSave();
		await delOk(r2.id);
		const afterDelete = { ...(await formState()), values: await fieldValues(), db: dbField('disbursements', r1.id, 'desc'), shown: (await rows()).find((r) => r.id === r1.id)?.cells[1], gone: !stored('disbursements').some((r) => r.id === r2.id) };
		const release = hold();
		try { await pressDelete(r3.id); await p.waitFor(`!!document.getElementById('register-delete-error')`, 30000); } finally { release(); }
		const afterFailedDelete = { ...(await formState()), values: await fieldValues(), kept: stored('disbursements').some((r) => r.id === r3.id) };
		await p.click('#register-retry');
		await p.waitFor(`!document.getElementById('register-error') && !document.querySelector('#register-form[data-editing]') && !document.getElementById('register-status')`, 30000);
		const afterRetry = { ...(await formState()), db: dbField('disbursements', r1.id, 'desc') };
		await p.click('#register-delete-dismiss');
		const dismissed = await formState();
		return { evidence: { afterDelete, afterFailedDelete, afterRetry, dismissed },
			checks: { saveErrorKept: /not saved/.test(afterDelete.error ?? '') && afterDelete.retry && afterDelete.editing === r1.id && afterDelete.values.desc === 'Synthetic row 1 UNSAVED' && afterDelete.gone,
				notShownAsSaved: afterDelete.db === 'Synthetic row 1 TYPED' && afterDelete.shown === 'Synthetic row 1 TYPED', deleteApart: /did not happen/.test(afterFailedDelete.deleteError ?? '') && /not saved/.test(afterFailedDelete.error ?? '') && afterFailedDelete.values.desc === 'Synthetic row 1 UNSAVED' && afterFailedDelete.kept,
				retrySaved: afterRetry.db === 'Synthetic row 1 UNSAVED' && afterRetry.error === null && /did not happen/.test(afterRetry.deleteError ?? ''), dismissed: dismissed.deleteError === null } };
	});

	await scenario('SC15-discard-guard', 'disbursements_tab', 'after a failed save, Edit on another row, Cancel and a navigation link ask before the unsaved input is discarded; Keep leaves the input and its error; Discard drops it on purpose (D5)', async () => {
		const [a, b] = await rows();
		await editRow(a.id);
		await fill({ desc: 'Synthetic UNSAVED for the guard' });
		await failSave();
		const ask = async (sel) => { await p.click(sel); await p.waitFor(`!!document.getElementById('register-ask')`, 5000); return formState(); };
		const askedEdit = await ask(`#register-table tr[data-row-id="${b.id}"] [data-edit]`);
		await p.click('#register-ask-keep');
		const kept = { ...(await formState()), values: await fieldValues() };
		const askedCancel = await ask('#register-cancel');
		await p.click('#register-ask-keep');
		const askedNav = { ...(await ask('#nav-timesheet_tab')), path: await p.evaluate('location.pathname') };
		await p.click('#register-ask-keep');
		const stayed = { ...(await formState()), values: await fieldValues(), path: await p.evaluate('location.pathname') };
		await ask(`#register-table tr[data-row-id="${b.id}"] [data-edit]`);
		await p.click('#register-ask-discard');
		await p.waitFor(`document.querySelector('#register-form')?.dataset.editing === ${J(b.id)}`, 5000);
		const discarded = { ...(await formState()), values: await fieldValues(), db: dbField('disbursements', a.id, 'desc') };
		await p.click('#register-cancel');
		const cleanCancel = await formState();
		await fill({ desc: 'Synthetic typed, never saved' });
		await ask('#nav-timesheet_tab');
		await p.click('#register-ask-discard');
		await p.waitFor(ready('timesheet_tab'), 15000);
		return { evidence: { askedEdit, kept, askedCancel, askedNav, stayed, discarded, cleanCancel },
			checks: { askEdit: /not saved/.test(askedEdit.ask ?? ''), keep: kept.editing === a.id && kept.values.desc === 'Synthetic UNSAVED for the guard' && /not saved/.test(kept.error ?? '') && kept.ask === null, askCancel: !!askedCancel.ask,
				askNav: !!askedNav.ask && /disbursements_tab$/.test(askedNav.path), stayed: /disbursements_tab$/.test(stayed.path) && stayed.values.desc === 'Synthetic UNSAVED for the guard' && !!stayed.error,
				discardOnPurpose: discarded.editing === b.id && discarded.error === null && discarded.values.desc === b.cells[1] && discarded.db === a.cells[1], cleanCancel: cleanCancel.editing === null && cleanCancel.ask === null, left: true } };
	});

	for (const [view, entry, change, empty] of [
		['timesheet_tab', { date: '2026-10-05', fee_earner: 'Synthetic earner', activity: 'Synthetic edit me', hours: '1.5', rate: '1000', billed: 'no' }, { activity: 'Synthetic edited', hours: '2.25' }, { date: '', fee_earner: '', activity: '', hours: '', rate: '', billed: '' }],
		['deadlines_tab', { title: 'Synthetic edit me', date: '2026-10-20', cat: 'Filing', note: '' }, { title: 'Synthetic edited', date: '2026-10-21', cat: 'Payment' }, { title: '', date: '', note: '' }],
		['annotations_tab', { ref: 'Synthetic missing ref', date: '', note: 'Synthetic edit me' }, { note: 'Synthetic edited\nsecond line' }, { ref: '', date: '', note: '' }],
	]) {
		await scenario(`SC16-${view}`, view, 'an entry edited in place: same id and position, new values in the store and on the page; an emptied edit says to use Delete and saves nothing (D18, D13)', async () => {
			await openView(view);
			const before = (await rows()).map((r) => r.id);
			await add(entry);
			const id = (await rows()).map((r) => r.id).find((x) => !before.includes(x));
			await editRow(id);
			await fill(change);
			await save(before.length + 1);
			const db = stored(STORE[view]).find((r) => r.id === id)?.fields ?? null;
			const shown = (await rows()).find((r) => r.id === id) ?? null;
			await editRow(id);
			await fill(empty);
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-error')`, 5000);
			const emptied = { ...(await formState()), dbAfter: stored(STORE[view]).find((r) => r.id === id)?.fields ?? null };
			await p.click('#register-discard');
			const after = await formState();
			return { evidence: { db, shown, emptied, after },
				checks: { sameId: shown?.id === id && stored(STORE[view]).filter((r) => r.id === id).length === 1, edited: Object.entries(change).every(([k, v]) => db?.[k] === v), why: /cannot be saved empty.*use Delete/.test(emptied.error ?? '') && emptied.editing === id,
					nothingWritten: J(emptied.dbAfter) === J(db), discarded: after.editing === null && after.error === null } };
		});
	}

	// 20-22. CC-07 r3 (verify r2): the discard question during a save, a failed delete after a confirmed discard, a 409.
	const ENTRY = { disbursements_tab: (n) => ({ date: `2026-10-0${n}`, desc: `Synthetic ask ${n}`, payee: 'Synthetic payee', amount: `${n}0` }), popia_tab: (n) => ({ activity: `Synthetic ask ${n}`, category: 'Synthetic category' }) };
	const FIELD = { disbursements_tab: 'desc', popia_tab: 'activity' };
	for (const view of ['disbursements_tab', 'popia_tab']) {
		const k = FIELD[view];
		await scenario(`SC20-${view}`, view, "the discard question open when a save starts closes and cannot be answered while the save is in flight; the failure stays on the submitted entry and Retry saves exactly that entry, never the other row (verify r2 medium 2)", async () => {
			await clearView(view);
			for (const n of [1, 2]) await add(ENTRY[view](n));
			const [r1, r2] = await rows();
			await editRow(r1.id);
			await fill({ [k]: 'Synthetic ask 1 TYPED' });
			await p.click(`#register-table tr[data-row-id="${r2.id}"] [data-edit]`);
			await p.waitFor(`!!document.getElementById('register-ask')`, 5000);
			const release = hold();
			let during, failed;
			try {
				await p.click('#register-save');
				await p.waitFor(`!!document.getElementById('register-status')`, 5000);
				const askOpen = await p.evaluate(`!!document.getElementById('register-ask-discard')`);
				if (askOpen) await p.click('#register-ask-discard');
				await sleep(200);
				during = { ...(await formState()), askOpen };
				await p.waitFor(`!!document.getElementById('register-error')`, 30000);
				failed = { ...(await formState()), values: await fieldValues() };
			} finally { release(); }
			const dbFailed = [dbField(STORE[view], r1.id, k), dbField(STORE[view], r2.id, k)];
			if (failed.retry) await p.click('#register-retry');
			await p.waitFor(`!document.getElementById('register-error') && !document.querySelector('#register-form[data-editing]') && !document.getElementById('register-status')`, 30000);
			const after = { form: await formState(), db: [dbField(STORE[view], r1.id, k), dbField(STORE[view], r2.id, k)] };
			return { evidence: { during, failed, dbFailed, after },
				checks: { askClosed: !during.askOpen && during.ask === null && during.editing === r1.id, failureOnSubmitted: failed.editing === r1.id && failed.values.rowId === r1.id && failed.values[k] === 'Synthetic ask 1 TYPED' && /not saved/.test(failed.error ?? '') && failed.retry,
					nothingWritten: J(dbFailed) === J(['Synthetic ask 1', 'Synthetic ask 2']), retrySavedSubmitted: J(after.db) === J(['Synthetic ask 1 TYPED', 'Synthetic ask 2']) && after.form.error === null } };
		});
	}
	await scenario('SC21-discard-then-delete-fails', 'disbursements_tab', 'a confirmed discard for Delete of the edited row, then a failed delete: the form leaves the entry, so the typed text is not shown as the stored entry (verify r2 low 3)', async () => {
		await openView('disbursements_tab');
		const [r1] = await rows();
		await editRow(r1.id);
		await fill({ desc: 'Synthetic discarded TYPED' });
		await pressDelete(r1.id);
		await p.waitFor(`!!document.getElementById('register-ask')`, 5000);
		const release = hold();
		try { await p.click('#register-ask-discard'); await p.waitFor(`!!document.getElementById('register-delete-error')`, 30000); } finally { release(); }
		const after = { ...(await formState()), values: await fieldValues(), kept: dbField('disbursements', r1.id, 'desc') };
		await p.click('#register-delete-dismiss');
		return { evidence: after,
			checks: { deleteFailed: /did not happen/.test(after.deleteError ?? '') && after.kept === 'Synthetic ask 1 TYPED', formLeft: after.editing === null && after.values.desc === '' && after.error === null } };
	});
	await scenario('SC22-stale-rebase', 'disbursements_tab', "after a 409 (changed in another tab) 'Load the current entry and keep my changes' takes the current version and keeps the typed values; a field the other tab changed and this tab left alone (Payee) takes the other tab's value, the field both changed names itself in a note; Save then keeps both changes (verify r2 low 6, review H1)", async () => {
		const [r1] = await rows();
		await editRow(r1.id);
		// another tab saves a change to the same entry with the version this form holds
		const other = await p.evaluate(`(async () => { const fd = new FormData(document.getElementById('register-form')); fd.set('desc', 'Synthetic other tab'); fd.set('payee', 'Synthetic other payee'); const r = await fetch(location.pathname + '?/save', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } }); return r.status; })()`);
		await fill({ desc: 'Synthetic stale TYPED' });
		await p.click('#register-save');
		await p.waitFor(`!!document.getElementById('register-error') && !document.getElementById('register-status')`, 30000);
		const stale = { ...(await formState()), rebase: await p.evaluate(`!!document.getElementById('register-rebase')`), db: dbField('disbursements', r1.id, 'desc') };
		if (stale.rebase) await p.click('#register-rebase');
		const rebased = { ...(await formState()), values: await fieldValues(), note: await p.evaluate(`document.getElementById('register-rebase-note')?.textContent.trim() ?? null`) };
		await save(await count());
		const after = { form: await formState(), db: dbField('disbursements', r1.id, 'desc'), payee: dbField('disbursements', r1.id, 'payee'), noteGone: await p.evaluate(`!document.getElementById('register-rebase-note')`) };
		return { evidence: { other, stale, rebased, after },
			checks: { conflict: /changed elsewhere/.test(stale.error ?? '') && stale.db === 'Synthetic other tab' && stale.rebase, kept: rebased.error === null && rebased.editing === r1.id && rebased.values.desc === 'Synthetic stale TYPED',
				otherFieldTaken: rebased.values.payee === 'Synthetic other payee', noteNamesField: /Description/.test(rebased.note ?? '') && !/Payee/.test(rebased.note ?? ''),
				saved: after.db === 'Synthetic stale TYPED' && after.form.error === null && after.form.editing === null, otherFieldSurvived: after.payee === 'Synthetic other payee', noteGone: after.noteGone } };
	});

	// H2 (review): the delete of the entry being edited makes the form inert, so text typed meanwhile is not lost on success
	await scenario('SC23-delete-inflight', 'disbursements_tab', "Edit X, then Delete X on a busy store: the form and Save are inert while the delete is in flight, text typed meanwhile does not enter the form, and after the store frees the row is deleted and the form is empty (review H2)", async () => {
		await openView('disbursements_tab');
		const [x] = await rows();
		await editRow(x.id);
		const loaded = await fieldValues();
		const release = hold();
		let during, typed, saveDuring;
		try {
			await pressDelete(x.id);
			await p.waitFor(`/Deleting/.test(document.getElementById('register-status')?.textContent ?? '')`, 5000);
			during = await formState();
			await p.type('#in-desc', 'Synthetic TYPED during delete');
			typed = await fieldValues();
			saveDuring = await p.evaluate(`document.getElementById('register-save').disabled`);
		} finally { release(); }
		await p.waitFor(`!document.querySelector('#register-table tr[data-row-id="${x.id}"]') && !document.getElementById('register-status')`, 30000);
		const after = { form: await formState(), values: await fieldValues(), db: dbField('disbursements', x.id, 'desc') };
		return { evidence: { during, typed, after },
			checks: { inert: during.fieldsDisabled === true && saveDuring === true, shown: /Deleting/.test(during.status ?? ''), nothingTyped: typed.desc === loaded.desc && !JSON.stringify(typed).includes('TYPED during delete'),
				deleted: after.db === null, formReset: after.form.editing === null && !after.form.fieldsDisabled && after.values.desc === '' } };
	});

	// M1 (review): the leave/discard question takes focus; Keep it gives it back; Discard moves it to the first field
	await scenario('SC24-dialog-focus', 'disbursements_tab', "Back with typed input: the question takes focus on Keep it and Keep it returns focus to the typed field, never <body>; Edit on another row then Keep it returns focus to that Edit button; Discard focuses the first field (review M1)", async () => {
		await openView('disbursements_tab');
		while ((await count()) < 2) await add({ date: '2026-10-09', desc: `Synthetic focus row ${await count()}`, payee: 'Synthetic payee', amount: '5' });
		const [a, b2] = await rows();
		const active = () => p.evaluate(`(() => { const e = document.activeElement; return { id: e?.id || null, tag: e?.tagName ?? null, cls: e?.className || null, edit: e?.closest?.('tr[data-row-id]')?.dataset.rowId ?? null, body: e === document.body } })()`);
		await openView('timesheet_tab');
		await p.click('#nav-disbursements_tab');
		await p.waitFor(`${ready('disbursements_tab')} && !!document.querySelector('main#main[data-hydrated]')`, 15000);
		await fill({ desc: 'Synthetic typed before Back' });
		await p.evaluate('history.back()');
		await p.waitFor(`!!document.getElementById('register-ask')`, 5000);
		await sleep(100);
		const asked = await active();
		await p.click('#register-ask-keep');
		await sleep(100);
		const keptBack = { ...(await active()), path: await p.evaluate('location.pathname'), value: (await fieldValues()).desc };
		await p.click(`#register-table tr[data-row-id="${b2.id}"] [data-edit]`);
		await p.waitFor(`!!document.getElementById('register-ask')`, 5000);
		await sleep(100);
		const askedEdit = await active();
		await p.click('#register-ask-keep');
		await sleep(100);
		const keptEdit = await active();
		await p.click(`#register-table tr[data-row-id="${b2.id}"] [data-edit]`);
		await p.waitFor(`!!document.getElementById('register-ask')`, 5000);
		await p.click('#register-ask-discard');
		await p.waitFor(`document.querySelector('#register-form')?.dataset.editing === ${J(b2.id)}`, 5000);
		await sleep(100);
		const discarded = await active();
		return { evidence: { asked, keptBack, askedEdit, keptEdit, discarded, a: a.id },
			checks: { askFocused: asked.id === 'register-ask-keep' && askedEdit.id === 'register-ask-keep', keepBack: keptBack.id === 'in-desc' && !keptBack.body && /disbursements_tab$/.test(keptBack.path) && keptBack.value === 'Synthetic typed before Back',
				keepEdit: !keptEdit.body && keptEdit.edit === b2.id, discardFirstField: discarded.id === 'in-date' } };
	});

	// L1 (review): a case id of 64 characters with no break opportunity does not make the register pages scroll sideways
	await scenario('SC25-narrow', 'disbursements_tab', 'the seven register pages of a case whose 64-character id has no break opportunity do not scroll sideways at 320 and 390 px (review L1)', async () => {
		const unbroken = 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz');
		const c = await buildCase(join(tmp, 'unbroken-id'), { caseId: unbroken });
		const imp = await A.c.importPkg(c.caseDir, c.pkgDir);
		if (!imp.importId) throw new Error(`unbroken-id import failed: ${imp.status} ${imp.location}`);
		const layouts = {};
		try {
			for (const width of [320, 390]) {
				await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
				for (const view of REGISTER_VIEWS) {
					await p.goto(`${A.origin}${vpath(c.resultsVersion)}/registers/${view}`, `${ready(view)} && !!document.querySelector('main#main[data-hydrated]')`);
					await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
					layouts[`${width}:${view}`] = await p.evaluate(`(() => { const de = document.documentElement; return { vw: de.clientWidth, scrollWidth: de.scrollWidth, banner: [...document.querySelectorAll('.banner')].some((e) => e.textContent.includes(${J(unbroken)})) }; })()`);
				}
			}
		} finally { await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {}); }
		return { evidence: { idLength: unbroken.length, layouts },
			checks: { idLength: unbroken.length === 64, noSideways: Object.values(layouts).every((l) => l.scrollWidth === l.vw), idShown: Object.values(layouts).every((l) => l.banner), all: Object.keys(layouts).length === 2 * REGISTER_VIEWS.length } };
	});

	await scenario('SC17-altered', 'popia_tab', 'a register row altered on disk since it was saved is marked on the page (D15); an entry of 60 000 CJK characters, under the 64 KiB store limit, is saved (multipart, D14)', async () => {
		await openView('popia_tab');
		await add({ activity: 'Synthetic as saved', category: '', lawful: '', retention: '' });
		const id = (await rows()).find((r) => r.cells[0] === 'Synthetic as saved')?.id;
		const w = new Database(join(A.dataDir, 'work.sqlite'));
		try { w.query("UPDATE register_row SET fields = replace(fields, 'Synthetic as saved', 'Synthetic altered') WHERE row_id = ?").run(id); } finally { w.close(); }
		await openView('popia_tab');
		const marked = await p.evaluate(`(() => { const r = document.querySelector('#register-table tr[data-row-id="${id}"]'); return { altered: r?.hasAttribute('data-altered') ?? false, note: r?.querySelector('.altered')?.textContent.trim() ?? null, others: document.querySelectorAll('#register-table tr[data-altered]').length }; })()`);
		await openView('transcriptions_tab');
		const n = await count();
		const body = '\u5b57'.repeat(60000);
		await fill({ title: 'Synthetic large transcript', body });
		await save(n + 1);
		const big = stored('transcripts').find((r) => r.fields.title === 'Synthetic large transcript');
		const err = await errorText();
		if (big) await del(big.id);
		return { evidence: { marked, err, bigLength: big?.fields.body.length ?? null },
			checks: { marked: marked.altered && /altered on disk/.test(marked.note ?? '') && marked.others === 1, largeSaved: err === null && big?.fields.body === body } };
	});

	await scenario('SC26-delete-confirm', 'deadlines_tab', 'GRS-175: one press of Delete deletes nothing: the row stays on the page and in the store, and the inline confirmation takes focus (Confirm delete, Cancel)', async () => {
		await clearView('deadlines_tab');
		await add({ title: 'Synthetic kept deadline', date: '2026-11-02', note: '' });
		const [r] = await rows();
		const row = `#register-table tr[data-row-id="${r.id}"]`;
		await p.click(`${row} [data-delete]`);
		await sleep(1500);
		const ev = { id: r.id, shown: (await rows()).some((x) => x.id === r.id), stored: stored('deadlines').some((x) => x.id === r.id), focus: await p.evaluate(`document.activeElement?.hasAttribute('data-delete-confirm') ?? false`), cancel: await p.evaluate(`!!document.querySelector(${J(`${row} [data-delete-cancel]`)})`) };
		return { evidence: ev, checks: { shown: ev.shown, stored: ev.stored, focus: ev.focus, cancel: ev.cancel } };
	});
	await scenario('SC27-delete-confirm-cases', 'deadlines_tab', "GRS-175: Cancel and Escape keep the row and return focus to its Delete; a second row's Delete moves the question and deletes nothing; a reload drops the question and keeps both rows; a POST without the row's confirmation is refused; Confirm delete deletes exactly that row", async () => {
		await openView('deadlines_tab');
		const [r] = await rows();
		await add({ title: 'Synthetic second deadline', date: '2026-11-03', note: '' });
		const o = (await rows()).find((x) => x.id !== r.id);
		const row = (x) => `#register-table tr[data-row-id="${x.id}"]`;
		const both = async () => { const ids = (await rows()).map((x) => x.id), db = stored('deadlines').map((x) => x.id); return [r, o].every((x) => ids.includes(x.id) && db.includes(x.id)); };
		const step = async () => ({ asking: await asking(p), focus: await focusOf(p, `${row(r)} [data-delete]`), both: await both() });
		await p.click(`${row(r)} [data-delete]`);
		const asked = await step();
		await holdEnter(p);
		await sleep(500);
		const heldConfirm = await step();
		if (!heldConfirm.both) throw new Error(`a held Enter on Confirm deleted without a second press: ${J(heldConfirm)}`);
		await p.click(`${row(r)} [data-delete-cancel]`);
		await sleep(300);
		const cancelled = await step();
		await p.click(`${row(r)} [data-delete]`);
		await p.evaluate(`document.querySelector(${J(`${row(r)} [data-delete-cancel]`)}).focus()`);
		await holdEnter(p, { first: true });
		await sleep(500);
		const heldCancel = await step();
		await cancelIfAsked(p, row(r));
		await sleep(300);
		await p.click(`${row(r)} [data-delete]`);
		await pressEscape(p);
		await sleep(300);
		const escaped = await step();
		await p.click(`${row(r)} [data-delete]`);
		await p.click(`${row(o)} [data-delete]`);
		await sleep(1000);
		const second = await step();
		await openView('deadlines_tab');
		const reloaded = await step();
		const bare = await postAction(p, '?/delete', { rowId: r.id });
		const other = await postAction(p, '?/delete', { rowId: r.id, confirm: o.id });
		const refused = await both();
		await del(r.id);
		const settled = await p.waitFor(`document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName : false`, 3000).catch(() => null);
		const ids = { page: (await rows()).map((x) => x.id), db: stored('deadlines').map((x) => x.id) };
		const ev = { settled, asked, heldConfirm, heldCancel, cancelled, escaped, second, reloaded, bare, other, refused, ids };
		return { evidence: ev, checks: {
			asked: J(asked.asking) === J([r.id]) && asked.focus === 'confirm' && asked.both,
			heldEnterOnConfirm: J(heldConfirm.asking) === J([r.id]) && heldConfirm.focus === 'confirm' && heldConfirm.both,
			heldEnterOnCancel: heldCancel.both,
			cancelKeeps: cancelled.asking.length === 0 && cancelled.focus === 'opener' && cancelled.both,
			escapeKeeps: escaped.asking.length === 0 && escaped.focus === 'opener' && escaped.both,
			secondMoves: J(second.asking) === J([o.id]) && second.both,
			reloadDrops: reloaded.asking.length === 0 && reloaded.both,
			serverRefuses: bare.type === 'failure' && bare.status === 400 && other.type === 'failure' && other.status === 400 && refused,
			confirmDeletesThatRow: J(ids.page) === J([o.id]) && J(ids.db) === J([o.id]),
			focusSettles: settled === 'H1' } };
	});
	await scenario('SC28-delete-failed-focus', 'deadlines_tab', "GRS-175 L1: a Confirm delete that fails leaves focus on that row's Delete, with the error shown and the row kept", async () => {
		await openView('deadlines_tab');
		const [r] = await rows();
		const row = `#register-table tr[data-row-id="${r.id}"]`;
		let focus = null;
		const release = hold();
		try {
			await p.click(`${row} [data-delete]`);
			await confirmPressed(p, row);
			await p.waitFor(`!!document.getElementById('register-delete-error')`, 30000);
			focus = await p.waitFor(`document.activeElement === document.querySelector(${J(`${row} [data-delete]`)})`, 5000).catch(() => false);
		} finally { release(); }
		const ev = { focus, now: await focusOf(p, `${row} [data-delete]`), kept: stored('deadlines').some((x) => x.id === r.id), error: await p.evaluate(`document.getElementById('register-delete-error')?.textContent.trim() ?? null`) };
		return { evidence: ev, checks: { errorShown: !!ev.error, rowKept: ev.kept, focusOnDelete: focus === true } };
	});
	await scenario('SC18-prodid', 'deadlines_tab', "the exported calendar's PRODID carries the case part from the package's view-content (read from the built synthetic package, raw text) (D18)", async () => {
		const field = vc ? JSON.parse(new TextDecoder().decode(vc)).data?.deadlines_tab?.icsProductId : undefined;
		const part = typeof field === 'string' ? field : null;
		await openView('deadlines_tab');
		const x = await exportNow();
		const prodid = (x?.text ?? '').split('\r\n').find((l) => l.startsWith('PRODID:')) ?? null;
		const esc = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
		return { evidence: { part: part !== null, prodid: prodid !== null },
			checks: { semicolon: part?.includes(';') === true && part.includes(','), fromData: part !== null && prodid === `PRODID:-//${esc(part)}//Workspace//EN` } };
	});
	// last, as it imports a second package: a package without view-content (viewCode: false), previewed as a candidate
	await scenario('SC19-neutral-export', 'deadlines_tab', "a package that names no calendar file or PRODID: Export .ics downloads deadlines.ics with the fixed note beside the export, and the neutral PRODID (BASE-R2 exportFileName, D18)", async () => {
		const neutral = await buildCase(join(tmp, 'neutral'), { caseId: 'e2e-registers-neutral', viewCode: false });
		const imp = await A.c.importPkg(neutral.caseDir, neutral.pkgDir);
		if (!imp.importId) throw new Error(`neutral import failed: ${imp.status} ${imp.location}`);
		await p.goto(`${A.origin}${vpath(neutral.resultsVersion)}/registers/deadlines_tab`, `${ready('deadlines_tab')} && !!document.querySelector('main#main[data-hydrated]')`);
		const note = await p.evaluate(`(() => { const n = [...document.querySelectorAll('[data-export-note]')]; const e = document.getElementById('register-export'); return { texts: n.map((x) => x.textContent.trim()), beside: n.length === 1 && n[0].parentElement === e?.parentElement }; })()`);
		const x = await exportNow();
		const nvc = neutral.files.get('datasets/view-content.json');
		const fields = nvc ? JSON.parse(new TextDecoder().decode(nvc)).data?.deadlines_tab ?? {} : {};
		return { evidence: { note, name: x?.name ?? null, fields: Object.keys(fields) },
			checks: { noField: fields.exportFileName === undefined && fields.icsProductId === undefined, neutralName: x?.name === 'deadlines.ics', note: J(note.texts) === J([EXPORT_NAME_NOTE]) && note.beside,
				neutralProdid: (x?.text ?? '').split('\r\n').includes('PRODID:-//ClearCase//Deadlines//EN') } };
	});
	ok = results.length > 0 && results.every((r) => r.pass);
} catch (e) {
	results.push({ id: 'HARNESS', view: '-', pass: false });
	writeFileSync(join(OUT, 'HARNESS.json'), J({ error: String(e?.stack ?? e).slice(0, 4000) }, null, 1));
	console.error(`FAIL    HARNESS ${String(e?.stack ?? e).slice(0, 2000)}`);
} finally {
	await b?.close().catch(() => {});
	await A?.stop().catch(() => {});
	if (tmp) rmSync(tmp, { recursive: true, force: true });
}
const missing = REGISTER_VIEWS.filter((v) => !results.some((r) => r.view === v));
if (missing.length) ok = false;
writeFileSync(join(OUT, 'summary.json'), J({ ok, offline: true, clock: CLOCK, missing, scenarios: results }, null, 1));
console.log(`registers: ${results.filter((r) => r.pass).length} PASS, ${results.filter((r) => !r.pass).length} FAIL${missing.length ? `, views without a scenario: ${missing.join(', ')}` : ''} -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
